const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbit', {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // providers + models
  listProviders: () => ipcRenderer.invoke('providers:list'),
  listModels: (providerId) => ipcRenderer.invoke('models:list', providerId),

  // chat history
  listChats: () => ipcRenderer.invoke('chats:list'),
  getChat: (id) => ipcRenderer.invoke('chats:get', id),
  saveChat: (chat) => ipcRenderer.invoke('chats:save', chat),
  deleteChat: (id) => ipcRenderer.invoke('chats:delete', id),

  // chat (streamed via events)
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  stopChat: () => ipcRenderer.invoke('chat:stop'),
  onToken: (cb) => ipcRenderer.on('chat:token', (_e, t) => cb(t)),
  onThinking: (cb) => ipcRenderer.on('chat:thinking', (_e, t) => cb(t)),
  onDone: (cb) => ipcRenderer.on('chat:done', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('chat:error', (_e, m) => cb(m)),
  onWarn: (cb) => ipcRenderer.on('chat:warn', (_e, m) => cb(m)),
  onForcedThinking: (cb) => ipcRenderer.on('chat:forcedThinking', (_e, d) => cb(d)),

  // audio / transcription
  audioStart: () => ipcRenderer.invoke('audio:start'),
  audioStop: () => ipcRenderer.invoke('audio:stop'),
  transcribe: (buffer) => ipcRenderer.invoke('audio:transcribe', buffer),
  onAudioStatus: (cb) => ipcRenderer.on('audio:status', (_e, s) => cb(s)),
  permStatus: () => ipcRenderer.invoke('perm:status'),
  openPerm: (kind) => ipcRenderer.invoke('perm:open', kind),

  // window
  hide: () => ipcRenderer.invoke('win:hide'),
  show: () => ipcRenderer.invoke('win:show'),
  restart: () => ipcRenderer.invoke('app:restart'),
  compact: () => ipcRenderer.invoke('win:compact'),
  widen: () => ipcRenderer.invoke('win:widen'),
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('win:setIgnoreMouse', ignore),

  // main -> renderer triggers
  onFocusInput: (cb) => ipcRenderer.on('focus-input', () => cb()),
  onClearChat: (cb) => ipcRenderer.on('clear-chat', () => cb())
});
