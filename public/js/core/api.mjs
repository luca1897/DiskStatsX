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

  async getResult() {
    const response = await fetch('/result');
    if (!response.ok) {
      return null;
    }
    return response.json();
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
