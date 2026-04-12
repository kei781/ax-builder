import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

interface BuildProgress {
  phase: string;
  current_task: string;
  files_created: number;
  files_total: number;
  elapsed_seconds: number;
  progress_percent: number;
}

interface WebSocketState {
  connected: boolean;
  lastEvent: string | null;
  progress: BuildProgress | null;
}

export function useWebSocket(projectId: string | undefined): WebSocketState {
  const [state, setState] = useState<WebSocketState>({
    connected: false,
    lastEvent: null,
    progress: null,
  });
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!projectId) return;

    const socket = io('/ws', {
      transports: ['websocket'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setState((prev) => ({ ...prev, connected: true }));
      socket.emit('join', { projectId });
    });

    socket.on('disconnect', () => {
      setState((prev) => ({ ...prev, connected: false }));
    });

    socket.on('build_progress', (data: BuildProgress) => {
      setState((prev) => ({ ...prev, lastEvent: 'build_progress', progress: data }));
    });

    socket.on('build_complete', () => {
      setState((prev) => ({ ...prev, lastEvent: 'build_complete' }));
    });

    socket.on('build_failed', () => {
      setState((prev) => ({ ...prev, lastEvent: 'build_failed' }));
    });

    return () => {
      socket.disconnect();
    };
  }, [projectId]);

  return state;
}
