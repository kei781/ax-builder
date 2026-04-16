import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

interface BuildProgress {
  phase: string;
  current_task: string;
  progress_percent: number;
}

interface WebSocketState {
  connected: boolean;
  lastEvent: string | null;
  progress: BuildProgress | null;
  logs: string[];
  /** 지금까지 수신된 phase 키 목록 (순서 유지, 중복 없음) */
  completedPhases: string[];
}

export function useWebSocket(projectId: string | undefined): WebSocketState {
  const [state, setState] = useState<WebSocketState>({
    connected: false,
    lastEvent: null,
    progress: null,
    logs: [],
    completedPhases: [],
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
      setState((prev) => {
        // _done 접미사가 붙은 phase는 해당 phase를 완료 목록에 추가
        const phase = data.phase;
        const completedPhases = [...prev.completedPhases];

        if (phase.endsWith('_done') || phase.endsWith('_failed')) {
          const basePhase = phase.replace(/_done$/, '').replace(/_failed$/, '');
          if (!completedPhases.includes(basePhase)) {
            completedPhases.push(basePhase);
          }
        }

        return {
          ...prev,
          lastEvent: 'build_progress',
          progress: data,
          completedPhases,
        };
      });
    });

    socket.on('build_complete', () => {
      setState((prev) => ({ ...prev, lastEvent: 'build_complete' }));
    });

    socket.on('build_failed', (data?: { lastPhase?: string }) => {
      setState((prev) => ({
        ...prev,
        lastEvent: 'build_failed',
        progress: data?.lastPhase
          ? { phase: data.lastPhase + '_failed', current_task: '빌드 실패', progress_percent: prev.progress?.progress_percent ?? 0 }
          : prev.progress,
      }));
    });

    socket.on('build_log', (data: { projectId: string; line: string }) => {
      if (data.projectId !== projectId) return;
      setState((prev) => ({
        ...prev,
        logs: [...prev.logs.slice(-500), data.line],
      }));
    });

    return () => {
      socket.disconnect();
    };
  }, [projectId]);

  return state;
}
