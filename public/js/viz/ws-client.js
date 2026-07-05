// Connects to the hand-rolled WebSocket telemetry endpoint (server/ws/*).
// Auth is a ?token= query param since the browser WebSocket constructor
// can't set custom headers the way fetch() can.
export function connectTelemetry(token, onEvent) {
  const wsUrl = `${window.AEGIS_WS_URL}?token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(wsUrl);
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return; // ignore malformed frames rather than crashing the UI
    }
    if (message.topic === 'telemetry') onEvent(message.data);
  });
  return socket;
}
