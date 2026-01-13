/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        // SGC Brand Colors
        sgc: {
          blue: {
            900: '#0a1520',
            700: '#0f2035',
            500: '#1e3a5f',
          },
          orange: {
            500: '#f7941d',
            600: '#e8850a',
            400: '#ffab40',
          },
        },
      },
      backgroundImage: {
        'sgc-gradient': 'linear-gradient(135deg, #0a1520 0%, #1e3a5f 100%)',
        'sgc-gradient-hover': 'linear-gradient(135deg, #0f2035 0%, #2a4a7f 100%)',
      },
      boxShadow: {
        'sgc': '0 4px 20px rgba(247, 148, 29, 0.15)',
        'sgc-lg': '0 8px 30px rgba(247, 148, 29, 0.2)',
      },
      animation: {
        'bounce-dot': 'bounce-dot 1.4s ease-in-out infinite',
      },
      keyframes: {
        'bounce-dot': {
          '0%, 80%, 100%': { transform: 'translateY(0)' },
          '40%': { transform: 'translateY(-6px)' },
        },
      },
    },
  },
  plugins: [],
}
