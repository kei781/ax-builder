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
  ): Promise<string> {
    this.logger.log(
      `Creating container for project ${projectId} on port ${port}`,
    );

    // Ensure base image is available; pull if missing.
    await this.ensureImage('node:20-slim');

    // Inside-container port is fixed at 3000. Apps that honor process.env.PORT
    // (the overwhelming majority of node templates) will pick this up.
    // Apps that hardcode a different port are broken — host QA observation
    // mode (ADR 0001) catches that before we get here, so in practice this
    // assumption holds for the apps that graduated past QA.
    const container = await this.docker.createContainer({
      Image: 'node:20-slim',
      name: `project-${projectId}`,
      Env: ['PORT=3000', 'NODE_ENV=production'],
      ExposedPorts: { '3000/tcp': {} },
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
      Cmd: ['sh', '-c', 'npm install && npm start'],
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
}
