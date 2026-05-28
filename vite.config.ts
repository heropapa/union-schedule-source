import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/union-schedule-test1/' : '/',
  plugins: [react()],
  server: {
    host: true,
    port: parseInt(process.env.PORT || '5173'),
    sourcemapIgnoreList: false, // 소스 맵 무시 리스트 해제
  },
  build: {
    sourcemap: true, // 빌드 시 소스 맵 생성
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          // 무거운 vendor 라이브러리는 별도 chunk로 빼서 앱 코드 캐시를 안정화
          'react-vendor': ['react', 'react-dom'],
          'supabase': ['@supabase/supabase-js'],
          'date-fns': ['date-fns'],
          'xlsx': ['xlsx'],
          'html-to-image': ['html-to-image'],
        },
      },
    },
  },
}))
