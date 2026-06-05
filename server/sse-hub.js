'use strict';

class SseHub {
  constructor() {
    this.clients = new Set();
  }

  attach(request, response, snapshot) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.flushHeaders?.();
    this.clients.add(response);
    this.send(response, 'snapshot', snapshot);
    request.on('close', () => this.clients.delete(response));
  }

  broadcast(event, data) {
    for (const client of this.clients) {
      this.send(client, event, data);
    }
  }

  send(response, event, data) {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

module.exports = { SseHub };
