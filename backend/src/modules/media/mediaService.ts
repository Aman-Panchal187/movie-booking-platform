import { v2 as cloudinary } from 'cloudinary';
import { Env } from '../../shared/config/env';
import { AppError } from '../../shared/errors/errors';

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type MediaKind = 'poster' | 'banner';

export interface UploadedMedia {
  url: string;
  publicId: string;
  width: number;
  height: number;
}

// Magic-number sniffing so a renamed file cannot masquerade as an image.
function looksLikeImage(buf: Buffer): boolean {
  const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  return isJpeg || isPng || isWebp;
}

export class MediaService {
  private readonly configured: boolean;

  constructor(env: Env) {
    this.configured = Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
    if (this.configured) {
      cloudinary.config({
        cloud_name: env.CLOUDINARY_CLOUD_NAME,
        api_key: env.CLOUDINARY_API_KEY,
        api_secret: env.CLOUDINARY_API_SECRET,
        secure: true,
      });
    }
  }

  get isConfigured(): boolean {
    return this.configured;
  }

  /** Uploads to Cloudinary. Throws 503 (never a fake URL) when credentials are not configured. */
  async uploadImage(file: { buffer: Buffer; mimetype: string; size: number }, kind: MediaKind): Promise<UploadedMedia> {
    if (!this.configured) {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Media uploads are not configured. Paste an https image URL instead.');
    }
    if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.mimetype) || !looksLikeImage(file.buffer)) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Only JPEG, PNG or WebP images are allowed');
    }
    if (file.size > MAX_IMAGE_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Image must be 5 MB or smaller');

    const transformation =
      kind === 'poster'
        ? [{ width: 600, height: 900, crop: 'fill', gravity: 'auto', quality: 'auto', fetch_format: 'auto' }]
        : [{ width: 1600, height: 700, crop: 'fill', gravity: 'auto', quality: 'auto', fetch_format: 'auto' }];

    return new Promise<UploadedMedia>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: `movie-booking/${kind}s`, resource_type: 'image', transformation, overwrite: false },
        (err, result) => {
          if (err || !result) return reject(new AppError(502, 'SERVICE_UNAVAILABLE', 'Image upload failed'));
          resolve({ url: result.secure_url, publicId: result.public_id, width: result.width, height: result.height });
        },
      );
      stream.end(file.buffer);
    });
  }
}
