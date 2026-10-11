const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (channel, input) => {
  const result = await ipcRenderer.invoke(channel, input);
  if (!result || result.ok !== true) throw new Error(result?.error || 'The action could not be completed.');
  return result.data;
};
contextBridge.exposeInMainWorld('chogcareAdmin', Object.freeze({
  snapshot: () => invoke('admin:snapshot'),
  settings: () => invoke('admin:settings'),
  action: input => invoke('admin:action', input),
  quote: input => invoke('admin:quote', input),
  listSupport: input => invoke('admin:support:list', input),
  updateSupport: input => invoke('admin:support:update', input),
  open: target => invoke('admin:open', target),
}));
