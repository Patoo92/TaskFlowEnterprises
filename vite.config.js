import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  // ─── AGREGAR ESTO PARA SOLUCIONAR EL BLOQUEO DE POPUPS ───
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
      "Cross-Origin-Embedder-Policy": "unsafe-none",
    },
  },
  // ────────────────────────────────────────────────────────
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'favicon.ico', 'robots.txt', 'apple-touch-icon.png'],
      manifest: {
        name: 'TaskFlow Enterprise',
        short_name: 'TaskFlow',
        description: 'Application for managing tasks and workspaces',
        theme_color: '#0d1117',
        background_color: '#ffffff',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        orientation: 'portrait-primary',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/pwa-maskable-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: '/pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ],
        screenshots: [
          {
            src: '/screenshot1.png',
            sizes: '540x720',
            form_factor: 'narrow',
            type: 'image/png'
          },
          {
            src: '/screenshot2.png',
            sizes: '1280x720',
            form_factor: 'wide',
            type: 'image/png'
          }
        ],
        categories: ['productivity', 'business']
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,vue,txt,wasm}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.(png|jpg|jpeg|svg|gif)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'image-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 30 // 30 días
              }
            }
          }
        ]
      }
    })
  ],
})
