import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/union-schedule-test1/' : '/',
  plugins: [react()],
  server: {
    host: true,
    port: parseInt(process.env.PORT || '5173'),
  },
}))
