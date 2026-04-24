module.exports = {
  apps: [
    {
      name: 'ax-orchestrator',
      cwd: './orchestrator',
      script: 'npm',
      args: 'run start:dev',
      env: {
        NODE_ENV: 'development',
        // pm2 God daemon이 Claude Desktop 컨텍스트에서 시작된 경우, 상위 쉘의
        // `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CODE_ENTRYPOINT` 등이 자동 상속됨.
        // 이 값이 만료된 토큰이면 자식 `claude` CLI가 Keychain보다 env를 우선
        // 읽어 401. 명시적으로 빈값을 주입해 Keychain fallback 강제.
        // (`claude auth login`으로 재인증해도 pm2 env가 stale이면 효과 없음 —
        // 회고 §8 참조.)
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_ENTRYPOINT: '',
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '',
      },
      watch: false,
    },
    {
      name: 'ax-planning-agent',
      cwd: './planning-agent',
      script: './venv/bin/uvicorn',
      args: 'app.main:app --host 127.0.0.1 --port 4100 --reload',
      interpreter: 'none',
      env: {
        NODE_ENV: 'development',
      },
      watch: false,
    },
    {
      name: 'ax-frontend',
      cwd: './frontend',
      script: 'npm',
      args: 'run dev',
      env: {
        NODE_ENV: 'development',
      },
      watch: false,
    },
  ],
};
