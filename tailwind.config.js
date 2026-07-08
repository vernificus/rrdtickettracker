/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eefbf2',
          100: '#d3f4dd',
          200: '#a9e9bf',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
          800: '#065f46',
          850: '#024e39',
          900: '#013a2b',
        },
        navy: {
          50: '#f0f4f8',
          700: '#1e293b',
          800: '#111827',
          900: '#0f172a',
          950: '#020617',
        },
        paper: '#f8fafc',
      }
    },
  },
  plugins: [],
};
