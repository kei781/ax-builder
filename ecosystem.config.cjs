module.exports = {
  apps: [
    {
      name: 'ax-orchestrator',
      cwd: './orchestrator',
      script: 'npm',
      args: 'run start:dev',
      env: {
        NODE_ENV: 'development',
      },
      watch: false,
    },
    {
      name: 'ax-planning-agent',
      cwd: './planning-agent',
      script: 'uvicorn',
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
