/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b0b10',
        surface: '#13131a',
        raised: '#1b1b25',
        line: '#2a2a38',
        ink: '#f4f4f7',
        muted: '#9d9db2',
        brand: { DEFAULT: '#ff4d5e', dim: '#d93a4a', soft: 'rgba(255,77,94,0.14)' },
        ok: '#34d399',
        warn: '#fbbf24',
        bad: '#f87171',
        info: '#60a5fa',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Sora', 'Inter', 'ui-sans-serif', 'sans-serif'],
      },
      borderRadius: { xl: '14px', '2xl': '20px' },
      boxShadow: { glow: '0 10px 40px -12px rgba(255,77,94,0.45)' },
    },
  },
  plugins: [],
};
