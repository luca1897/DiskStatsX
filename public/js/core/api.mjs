async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with status ${response.status}`);
  }
  return payload;
}

export class ApiClient {
  async getConfig() {
    const response = await fetch('/config');
    return parseResponse(response);
  }

  async startScan(path, filters) {
    const response = await fetch('/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, filters })
    });
    return parseResponse(response);
  }

  async cancelScan() {
    const response = await fetch('/cancel', { method: 'POST' });
    return parseResponse(response);
  }

  async getResult(path, { signal } = {}) {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    const response = await fetch(`/result${query}`, { signal });
    return parseResponse(response);
  }

  async getHistory() {
    const response = await fetch('/history');
    return parseResponse(response);
  }

  async activateHistory(id) {
    const response = await fetch('/history/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    return parseResponse(response);
  }

  async compareHistory(beforeId, afterId, { signal } = {}) {
    const query = new URLSearchParams({ beforeId, afterId });
    const response = await fetch(`/compare?${query}`, { signal });
    return parseResponse(response);
  }

  async searchFiles(options, { signal } = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options || {})) {
      if (value !== undefined && value !== null && value !== '' && value !== false) {
        query.set(key, String(value));
      }
    }
    const response = await fetch(`/search?${query}`, { signal });
    return parseResponse(response);
  }

  async getCleanup(options = {}, { signal } = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== null && value !== '') {
        query.set(key, String(value));
      }
    }
    const response = await fetch(`/cleanup?${query}`, { signal });
    return parseResponse(response);
  }

  async runSystemAction(action, path) {
    const response = await fetch('/system-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, path })
    });
    return parseResponse(response);
  }

  connectEvents(handlers) {
    const source = new EventSource('/events');
    for (const [eventName, handler] of Object.entries(handlers)) {
      if (eventName === 'connection-error') {
        source.addEventListener('error', () => handler());
        continue;
      }
      source.addEventListener(eventName, (event) => {
        handler(JSON.parse(event.data));
      });
    }
    return source;
  }
}
