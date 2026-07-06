import { contextBridge } from 'electron'

// Expose a typed API to the renderer process
// All Node.js/Electron APIs must be exposed here — renderer has no direct access
contextBridge.exposeInMainWorld('pmos', {
  platform: process.platform,
  // IPC channels will be added here as features are built
})
