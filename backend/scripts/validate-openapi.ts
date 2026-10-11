process.env.DATABASE_URL ??= 'postgres://unused:unused@localhost:5432/unused';
process.env.JWT_SECRET ??= 'validate-openapi-only-secret';

import SwaggerParser from '@apidevtools/swagger-parser';

async function main() {
  const { openApiSpec } = await import('../src/openapi/spec.js');
  const api = await SwaggerParser.validate(structuredClone(openApiSpec) as never);
  console.log(`OpenAPI ${(api as { openapi: string }).openapi} valid: ${Object.keys(openApiSpec.paths).length} paths`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
