module.exports = {
  apps: [
    {
      name: 'ax-backend',
      cwd: './backend',
      script: 'npm',
      args: 'run start:dev',
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
