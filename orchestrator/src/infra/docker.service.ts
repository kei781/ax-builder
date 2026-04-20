import { Injectable, Logger } from '@nestjs/common';
import Docker from 'dockerode';

@Injectable()
export class DockerService {
  private readonly logger = new Logger(DockerService.name);
  private readonly docker: Docker;

  constructor() {
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
  }

  async createContainer(
    projectId: string,
    projectPath: string,
    port: number,
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    this.logger.log(
      `Creating container for project ${projectId} on port ${port} (envs=${Object.keys(extraEnv).length})`,
    );

    // Ensure base image is available; pull if missing.
    await this.ensureImage('node:20-slim');

    // Inside-container port is fixed at 3000. Apps that honor process.env.PORT
    // (the overwhelming majority of node templates) will pick this up.
    // Apps that hardcode a different port are broken — host QA observation
    // mode (ADR 0001) catches that before we get here, so in practice this
    // assumption holds for the apps that graduated past QA.
    //
    // `/app/node_modules`는 anonymous volume으로 가립다. 호스트 QA가 이미
    // macOS용 native bindings(better-sqlite3 등)을 설치해둔 상태로 Linux
    // 컨테이너에 bind-mount되면 `invalid ELF header`로 죽는다. 빈 볼륨으로
    // 덮어서 컨테이너가 `npm install`로 올바른 Linux 바이너리를 새로
    // 세팅하도록 한다.
    //
    // `extraEnv` — project_env_vars의 복호화된 값들. 앱이 `require('dotenv').config()`
    // 를 호출하지 않아도 process.env에서 읽을 수 있도록 Docker Env로 주입한다.
    // 플랫폼 기본값(PORT/NODE_ENV)보다 나중에 넣어 덮어쓰기 허용.
    const baseEnv: Record<string, string> = {
      PORT: '3000',
      NODE_ENV: 'production',
      ...extraEnv,
    };
    const envArray = Object.entries(baseEnv).map(([k, v]) => `${k}=${v}`);

    const container = await this.docker.createContainer({
      Image: 'node:20-slim',
      name: `project-${projectId}`,
      Env: envArray,
      ExposedPorts: { '3000/tcp': {} },
      Volumes: {
        '/app/node_modules': {},
      },
      HostConfig: {
        PortBindings: {
          '3000/tcp': [{ HostPort: String(port) }],
        },
        Binds: [
          `${projectPath}:/app`,
          `${projectPath}/data:/app/data`,
        ],
        Memory: 512 * 1024 * 1024, // 512MB
        NanoCpus: 500000000, // 0.5 CPU
      },
      WorkingDir: '/app',
      Cmd: ['sh', '-c', 'npm install --no-audit --no-fund && npm start'],
    });

    return container.id;
  }

  /** Pull the image if it isn't already present locally. */
  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return; // already present
    } catch {
      // not found — pull
    }
    this.logger.log(`Pulling image: ${image}`);
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(
          stream,
          (err2: Error | null) => (err2 ? reject(err2) : resolve()),
        );
      });
    });
    this.logger.log(`Pulled image: ${image}`);
  }

  async startContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.start();
    this.logger.log(`Container ${containerId} started`);
  }

  async stopContainer(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop();
      this.logger.log(`Container ${containerId} stopped`);
    } catch (error: any) {
      if (error?.statusCode !== 304) {
        throw error;
      }
      // Already stopped
    }
  }

  async removeContainer(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.remove({ force: true });
      this.logger.log(`Container ${containerId} removed`);
    } catch (error: any) {
      if (error?.statusCode !== 404) {
        throw error;
      }
    }
  }

  async restartContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.restart();
    this.logger.log(`Container ${containerId} restarted`);
  }

  /**
   * Fetch combined stdout+stderr logs of a container (as text).
   * Used by FailureClassifier to figure out why env_qa failed.
   */
  async getLogs(
    containerId: string,
    tailLines = 500,
  ): Promise<string> {
    try {
      const container = this.docker.getContainer(containerId);
      const stream = (await container.logs({
        stdout: true,
        stderr: true,
        tail: tailLines,
        timestamps: false,
      })) as unknown as Buffer;
      // When follow=false, dockerode returns the raw multiplexed buffer.
      // Each frame = 8-byte header + payload. We strip headers; for non-TTY
      // containers the header's first byte is stream-id (1=stdout, 2=stderr).
      return demultiplex(Buffer.isBuffer(stream) ? stream : Buffer.from(stream));
    } catch (err: any) {
      this.logger.warn(`getLogs failed: ${err?.message ?? err}`);
      return '';
    }
  }
}

/** Strip the 8-byte per-frame header from Docker's multiplexed log stream. */
function demultiplex(buf: Buffer): string {
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = start + size;
    if (end > buf.length) break;
    parts.push(buf.subarray(start, end));
    i = end;
  }
  if (parts.length === 0) return buf.toString('utf8');
  return Buffer.concat(parts).toString('utf8');
}
