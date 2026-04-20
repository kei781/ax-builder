import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Not, IsNull } from 'typeorm';
import * as net from 'net';
import { Project } from '../projects/entities/project.entity.js';
import { ConfigService } from '@nestjs/config';

/**
 * Allocates an available port from PROJECT_PORT_RANGE for a new deploy.
 *
 * 점유 판정 기준 (보수적 union):
 *   1. 상태 기반: 컨테이너를 돌리고 있을 수 있는 모든 state
 *      (첫 빌드 라인 + 업데이트 라인 + env 사이드 + ADR 0008)
 *   2. 컨테이너 기반: state에 관계없이 `container_id`가 설정된 모든 row.
 *      실패 후 좀비 컨테이너가 정리 안 돼서 포트 잡고 있는 케이스 방지.
 *   3. **블랙리스트**: 앱 코드가 흔히 하드코딩하는 포트(3000/5000/8000/8080 등)
 *      는 배포 호스트 포트로 할당하지 않는다. 할당 순간엔 비어 있어도 QA가
 *      호스트에서 `npm start`로 띄울 때 그 포트에 바인드 시도→충돌 유발.
 *   4. **OS 레벨 bind 체크**: DB가 비었다고 해도 실제 OS에서 바인드 시도해
 *      EADDRINUSE 나면 skip. 외부 프로세스·좀비 등 방어.
 *
 * 트랜잭션 안에서 할당해 동시 할당 race condition 차단.
 */
@Injectable()
export class PortAllocatorService {
  private readonly logger = new Logger(PortAllocatorService.name);
  private readonly portStart: number;
  private readonly portEnd: number;

  /**
   * 앱들이 자주 하드코딩하는 포트 — 배포 호스트 포트로 쓰지 않는다.
   * 이 포트로 배포하면 같은 앱의 다음 QA가 호스트에서 충돌.
   * 추가로 orchestrator/Vite 등 플랫폼 자체 포트도 예약.
   */
  private readonly BLACKLISTED_PORTS = new Set([
    3000, // Express 기본 (Claude Code 가장 자주 하드코딩)
    3001, // Next.js 기본 보조
    4000, // orchestrator Nest
    4100, // planning-agent
    5000, // Flask 기본
    5173, // Vite dev
    5174, // Vite preview
    8000, // FastAPI·Django 기본
    8080, // Spring·express 범용
  ]);

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    this.portStart = this.configService.get<number>(
      'PROJECT_PORT_RANGE_START',
      3000,
    );
    this.portEnd = this.configService.get<number>(
      'PROJECT_PORT_RANGE_END',
      3999,
    );
  }

  async allocate(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      // DB 기반 점유 포트 수집:
      // (a) 컨테이너가 살아있을 가능성이 있는 모든 state
      // (b) state와 무관하게 container_id가 설정된 row (좀비 방어)
      const allProjects = await manager.find(Project, {
        where: [
          { container_id: Not(IsNull()) },
          { port: Not(IsNull()) },
        ],
        select: ['port', 'container_id', 'state', 'id'],
      });

      const usedPorts = new Set<number>();
      for (const p of allProjects) {
        if (p.port !== null) {
          usedPorts.add(p.port);
        }
      }

      // 범위 순회 — 블랙리스트·DB 점유·OS 점유 모두 피해야 pass.
      for (let port = this.portStart; port <= this.portEnd; port++) {
        if (this.BLACKLISTED_PORTS.has(port)) continue;
        if (usedPorts.has(port)) continue;
        if (!(await this.isPortFree(port))) {
          this.logger.warn(
            `port ${port}: DB 여유이지만 OS 바인드 불가 (외부 점유), skip`,
          );
          continue;
        }
        return port;
      }

      throw new Error('사용 가능한 포트가 없습니다.');
    });
  }

  /**
   * OS에 실제 바인드 가능한지 확인 (TCP, localhost).
   * 0.0.0.0으로 바인드해서 IPv4/IPv6 모두 점검. 테스트 소켓은 즉시 close.
   * 이 체크는 race window가 있음 — 할당 직후~Docker bind 사이에 누가 잡으면
   * createContainer에서 실패. Docker가 명확한 에러 남기므로 허용 가능한 손실.
   */
  async isPortFree(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const tester = net.createServer();
      tester.once('error', () => resolve(false));
      tester.once('listening', () => {
        tester.close(() => resolve(true));
      });
      tester.listen(port, '0.0.0.0');
    });
  }
}
