import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Conversation, ConversationType } from '../projects/entities/conversation.entity.js';
import { Project } from '../projects/entities/project.entity.js';
import { PrdGeneratorService } from './prd-generator.service.js';
import { v4 as uuidv4 } from 'uuid';

export interface ScoreBreakdown {
  problem_definition: number;
  feature_list: number;
  user_flow: number;
  feasibility: number;
  user_experience: number;
}

export interface ScoreResult {
  reply: string;
  current_phase: string;
  score: number;
  score_tier: string;
  score_label: string;
  score_passed: boolean;
  breakdown: ScoreBreakdown;
  missing_items: string[];
  /** Claude CLI가 백그라운드에서 PRD/DESIGN 재생성 중인지 */
  prd_generating: boolean;
  /** 현재까지 누적된 대화 턴 수 */
  turn_count: number;
  /** 마지막으로 PRD를 생성한 시점의 턴 수 */
  last_prd_gen_turn: number;
  /** PRD가 생성된 시점 이후 새 대화가 있으면 구버전 */
  prd_outdated: boolean;
  design_outdated: boolean;
  /** 이번 응답으로 처음 900점에 도달했는지 */
  crossed_900: boolean;
  /** 마지막 Claude CLI 생성 시도 에러 (있으면 UI 알림) */
  prd_gen_error: string | null;
}

function getScoreTier(score: number) {
  if (score >= 900)
    return { tier: 'ready_to_build', label: '🟢 제작 가능', passed: true };
  if (score >= 700)
    return { tier: 'process_complete', label: '🟡 프로세스 완료 — 세부사항 보완 필요', passed: false };
  if (score >= 500)
    return { tier: 'problem_defined', label: '🟠 문제 정리됨 — 프로세스 미정립', passed: false };
  return { tier: 'too_vague', label: '🔴 지나치게 모호함', passed: false };
}

const SCORING_SYSTEM_PROMPT = `당신은 비개발자의 모호한 불편함을 "기술적으로 해결 가능한 문제"로 구조화하는
Discovery Agent입니다. 단순한 PRD 평가가 아니라, 사용자의 문제를 함께 쪼개는
과정을 진행합니다.

## 대화 단계

### 1단계: 문제 발견 (Lean Canvas 기반)
아래 질문을 자연스러운 대화로 하나씩 풀어가세요:
- "어떤 상황에서 불편함을 느끼시나요?" (Problem)
- "지금은 어떻게 해결하고 계세요?" (Existing Alternatives)
- "이게 해결되면 어떤 상태가 되면 좋겠어요?" (Value Proposition)
- "이걸 주로 누가 쓰게 될까요? 본인만? 팀?" (Customer Segments)

### 2단계: 기능 구조화 (User Story Map 기반)
문제가 파악되면, 유저 스토리로 전환하세요:
- "그러면 [사용자]가 [목표]를 달성하려면, 먼저 뭘 해야 하나요?"
- "그 다음은요?"
- 각 단계를 "~할 수 있다" 형태의 기능으로 정리

### 3단계: 기술적 실현 가능성 검증
- 외부 API가 필요한지, 데이터 저장이 필요한지 확인
- 데이터 저장이 필요하면 SQLite를 사용할 것임을 안내 (사용자에게는 "앱 안에 데이터가 자동 저장됩니다" 정도로 설명)
- 단일 웹앱으로 구현 가능한 범위로 스코프를 조절
- 비개발자 용어로 기술적 제약을 설명

## 스코어링 기준 (각 항목 0~200점, 총 1000점)

1. **문제 정의** (200점): 누구의 어떤 불편함인지 구체적인가?
2. **기능 목록** (200점): 유저 스토리가 빠짐없이 정의되었는가?
3. **사용 흐름** (200점): 첫 접속 → 목표 달성까지의 경로가 있는가?
4. **기술 실현성** (200점): 단일 웹앱으로 구현 가능한 범위인가?
5. **사용자 경험** (200점): UI/UX 흐름, 에러 처리, 온보딩이 설계되었는가?

### 스코어 구간별 의미

| 구간 | 상태 | 의미 |
|---|---|---|
| 0~499 | too_vague | 문제 자체가 지나치게 모호함 |
| 500~699 | problem_defined | 문제는 파악됐으나 해결 프로세스가 미정립 |
| 700~899 | process_complete | 기능과 흐름까지 정리됐으나, 구현하기엔 부족 |
| 900~1000 | ready_to_build | UI/UX까지 충분히 설계됨. 빌드 가능 |

## 응답 형식

항상 아래 JSON 구조를 응답 마지막에 포함하세요 (PRD/DESIGN 문서는 별도 시스템이 생성하니 여기선 절대 포함 금지):

\`\`\`json
{
  "current_phase": "discovery" | "structuring" | "validation",
  "score": 650,
  "score_tier": "process_incomplete",
  "breakdown": {
    "problem_definition": 160,
    "feature_list": 130,
    "user_flow": 120,
    "feasibility": 140,
    "user_experience": 100
  },
  "missing_items": [
    "데이터를 새로고침해도 유지할지 결정 필요",
    "에러 발생 시 사용자에게 보여줄 메시지 미정"
  ],
  "passed": false
}
\`\`\`

## 규칙
- 점수가 900점 이상이면 passed: true
- score_tier: "too_vague"(~499) | "problem_defined"(500~699) | "process_complete"(700~899) | "ready_to_build"(900~)
- current_phase를 항상 표시하여 사용자가 지금 어느 단계인지 알게 함
- 대화 초반에는 점수를 낮게 주되, 구체적으로 뭘 보완하면 점수가 오를지 안내
- 비개발자도 이해할 수 있는 용어만 사용. 전문 용어 사용 시 반드시 쉬운 설명 병기
- 한 번에 질문은 최대 2개까지
- PRD나 DESIGN 문서는 절대 직접 작성하지 말 것 (별도 시스템에서 Claude가 생성함). 당신은 대화와 스코어링에만 집중
- 시스템이 제공하는 "[현재 PRD/DESIGN 초안]" 컨텍스트가 있으면 참고해서 중복 질문 피하고, 비어 있거나 [미정]인 부분을 물어볼 것
- "프로세스화가 불가능하다"고 느끼는 사용자도 있으므로, 작은 단위로 쪼개서 질문`;

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);
  private readonly openai: OpenAI;
  private readonly chatModel: string;

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    private readonly configService: ConfigService,
    private readonly prdGenerator: PrdGeneratorService,
  ) {
    // OpenRouter — OpenAI 호환 API
    this.openai = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: this.configService.get<string>('OPENROUTER_API_KEY', ''),
    });
    // 기획 채팅: Gemini 3 Flash Preview via OpenRouter
    this.chatModel = this.configService.get<string>(
      'CHAT_MODEL',
      'google/gemini-3-flash-preview',
    );
  }

  async chat(
    projectId: string,
    userId: string,
    message: string,
    type: ConversationType,
  ): Promise<ScoreResult> {
    // 1. Load or create conversation
    let conversation = await this.conversationRepo.findOne({
      where: { project_id: projectId, user_id: userId, type },
    });

    if (!conversation) {
      conversation = this.conversationRepo.create({
        id: uuidv4(),
        project_id: projectId,
        user_id: userId,
        type,
        conversation_history: [],
        current_score: 0,
        score_tier: 'too_vague',
        score_passed: false,
        last_prd_gen_turn: 0,
        last_prd_gen_score: 0,
      });
    }

    // 프로젝트 기존 PRD/DESIGN을 컨텍스트로 주입 (Gemini가 중복 질문 안 하도록)
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    const existingPrd = project?.prd_content || null;
    const existingDesign = project?.design_content || null;

    // 2. 최근 6개 메시지만 전송 (토큰 비용 절감)
    const history = conversation.conversation_history || [];
    const MAX_HISTORY = 6;
    const recentHistory = history.slice(-MAX_HISTORY);

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: SCORING_SYSTEM_PROMPT },
    ];

    // 기존 PRD/DESIGN 초안이 있으면 시스템 컨텍스트로 주입
    if (existingPrd || existingDesign) {
      const ctx: string[] = ['[현재까지 정리된 초안 — 참고용, 직접 수정하지 말 것]'];
      if (existingPrd) ctx.push(`\n### 현재 PRD 초안\n${existingPrd}`);
      if (existingDesign) ctx.push(`\n### 현재 DESIGN 초안\n${existingDesign}`);
      messages.push({ role: 'system', content: ctx.join('\n') });
    }

    // 이전 대화가 잘린 경우, 컨텍스트 요약 추가
    if (history.length > MAX_HISTORY) {
      messages.push({
        role: 'user',
        content: `[이전 대화 요약] 현재 스코어: ${conversation.current_score}/1000, 단계: ${conversation.score_tier}. 이어서 진행해주세요.`,
      });
    }

    for (const m of recentHistory) {
      messages.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      });
    }
    messages.push({ role: 'user', content: message });

    // 3. Call OpenRouter API
    let responseText: string;
    try {
      const response = await this.openai.chat.completions.create({
        model: this.chatModel,
        messages,
        max_tokens: 4096,
      });
      responseText = response.choices[0]?.message?.content ?? 'AI 응답을 받지 못했습니다.';
    } catch (error: any) {
      this.logger.error(`OpenRouter API error (${this.chatModel}):`, error?.message);
      if (error?.status === 429) {
        responseText = 'API 요청 한도에 도달했습니다. 잠시 후 다시 시도해주세요.';
      } else {
        responseText = 'AI 연결에 문제가 발생했습니다. 잠시 후 다시 시도해주세요.';
      }
    }

    // 4. Parse JSON block from response
    const parsed = this.parseScoreJson(responseText);

    // 5. Update conversation history
    const prevScore = conversation.current_score;
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: responseText });
    conversation.conversation_history = history;
    conversation.current_score = parsed.score;
    conversation.score_tier = parsed.score_tier;
    conversation.score_passed = parsed.passed;
    await this.conversationRepo.save(conversation);

    // 6. Update project score
    await this.projectRepo.update(projectId, { score: parsed.score });

    // 7. Build result
    const tierInfo = getScoreTier(parsed.score);
    const turnCount = Math.floor(history.length / 2);
    const lastGenTurn = conversation.last_prd_gen_turn || 0;
    const crossed900 = prevScore < 900 && parsed.score >= 900;

    return {
      reply: this.stripJsonBlock(responseText),
      current_phase: parsed.current_phase,
      score: parsed.score,
      score_tier: tierInfo.tier,
      score_label: tierInfo.label,
      score_passed: tierInfo.passed,
      breakdown: parsed.breakdown,
      missing_items: parsed.missing_items,
      prd_generating: this.prdGenerator.isRunning(projectId),
      turn_count: turnCount,
      last_prd_gen_turn: lastGenTurn,
      prd_outdated: !!existingPrd && turnCount > lastGenTurn,
      design_outdated: !!existingDesign && turnCount > lastGenTurn,
      crossed_900: crossed900,
      prd_gen_error: this.prdGenerator.getStatus(projectId).lastError,
    };
  }

  /**
   * 수동 PRD/DESIGN 재생성 트리거.
   * 900점 이상일 때만 허용.
   */
  async regeneratePrd(projectId: string, userId: string): Promise<{ started: boolean; message: string }> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) throw new Error('Project not found');
    if (project.score < 900) {
      return { started: false, message: '900점 이상일 때만 재생성할 수 있습니다.' };
    }
    if (this.prdGenerator.isRunning(projectId)) {
      return { started: false, message: '이미 생성 중입니다.' };
    }

    // owner의 scoring conversation 사용
    const conversation = await this.conversationRepo.findOne({
      where: { project_id: projectId, user_id: project.user_id, type: 'scoring' },
    });
    if (!conversation) {
      return { started: false, message: '대화 이력이 없습니다.' };
    }

    const history = conversation.conversation_history || [];
    const turnCount = Math.floor(history.length / 2);
    conversation.last_prd_gen_turn = turnCount;
    conversation.last_prd_gen_score = project.score;
    await this.conversationRepo.save(conversation);

    void this.prdGenerator.generateInBackground(
      projectId,
      history,
      project.prd_content || null,
      project.design_content || null,
    );

    this.logger.log(`Manual PRD regen triggered for ${projectId} by ${userId} (turn ${turnCount})`);
    return { started: true, message: 'PRD/DESIGN 생성을 시작했습니다. 30초~2분 소요됩니다.' };
  }

  private parseScoreJson(text: string): {
    current_phase: string;
    score: number;
    score_tier: string;
    breakdown: ScoreBreakdown;
    missing_items: string[];
    passed: boolean;
  } {
    const defaults = {
      current_phase: 'discovery',
      score: 0,
      score_tier: 'too_vague',
      breakdown: {
        problem_definition: 0,
        feature_list: 0,
        user_flow: 0,
        feasibility: 0,
        user_experience: 0,
      },
      missing_items: [] as string[],
      passed: false,
    };

    try {
      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
      if (!jsonMatch) return defaults;

      const parsed = JSON.parse(jsonMatch[1]);
      return {
        current_phase: parsed.current_phase || defaults.current_phase,
        score: typeof parsed.score === 'number' ? parsed.score : defaults.score,
        score_tier: parsed.score_tier || defaults.score_tier,
        breakdown: {
          problem_definition: parsed.breakdown?.problem_definition || 0,
          feature_list: parsed.breakdown?.feature_list || 0,
          user_flow: parsed.breakdown?.user_flow || 0,
          feasibility: parsed.breakdown?.feasibility || 0,
          user_experience: parsed.breakdown?.user_experience || 0,
        },
        missing_items: Array.isArray(parsed.missing_items)
          ? parsed.missing_items
          : defaults.missing_items,
        passed: parsed.passed === true,
      };
    } catch {
      this.logger.warn('Failed to parse score JSON from response');
      return defaults;
    }
  }

  private stripJsonBlock(text: string): string {
    return text.replace(/```json[\s\S]*?```/, '').trim();
  }

  async getHistory(
    projectId: string,
    userId: string,
    type: ConversationType,
  ) {
    // 프로젝트 owner 기준으로 대화 조회 (viewer도 owner 대화를 볼 수 있게)
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    const ownerId = project?.user_id || userId;
    const prdContent = project?.prd_content || null;
    const designContent = project?.design_content || null;

    const conversation = await this.conversationRepo.findOne({
      where: { project_id: projectId, user_id: ownerId, type },
    });

    if (!conversation) {
      return {
        messages: [] as Array<{ role: string; content: string }>,
        score: 0,
        score_tier: 'too_vague',
        score_label: '대화를 시작하세요',
        score_passed: false,
        current_phase: 'discovery',
        breakdown: {
          problem_definition: 0,
          feature_list: 0,
          user_flow: 0,
          feasibility: 0,
          user_experience: 0,
        },
        missing_items: [] as string[],
        prd_content: prdContent,
        design_content: designContent,
        prd_generating: this.prdGenerator.isRunning(projectId),
        turn_count: 0,
        last_prd_gen_turn: 0,
        prd_outdated: false,
        design_outdated: false,
        prd_gen_error: this.prdGenerator.getStatus(projectId).lastError,
      };
    }

    const messages = (conversation.conversation_history || []).map(
      (m: { role: string; content: string }) => ({
        role: m.role,
        content:
          m.role === 'assistant' ? this.stripJsonBlock(m.content) : m.content,
      }),
    );

    const lastAssistant = [...(conversation.conversation_history || [])]
      .reverse()
      .find((m: { role: string; content: string }) => m.role === 'assistant');
    const parsed = lastAssistant
      ? this.parseScoreJson(lastAssistant.content)
      : null;

    const tierInfo = getScoreTier(conversation.current_score);

    return {
      messages,
      score: conversation.current_score,
      score_tier: tierInfo.tier,
      score_label: tierInfo.label,
      score_passed: tierInfo.passed,
      current_phase: parsed?.current_phase || 'discovery',
      breakdown: parsed?.breakdown || {
        problem_definition: 0,
        feature_list: 0,
        user_flow: 0,
        feasibility: 0,
        user_experience: 0,
      },
      missing_items: parsed?.missing_items || [],
      prd_content: prdContent,
      design_content: designContent,
      prd_generating: this.prdGenerator.isRunning(projectId),
      turn_count: Math.floor((conversation.conversation_history || []).length / 2),
      last_prd_gen_turn: conversation.last_prd_gen_turn || 0,
      prd_outdated:
        !!prdContent &&
        Math.floor((conversation.conversation_history || []).length / 2) > (conversation.last_prd_gen_turn || 0),
      design_outdated:
        !!designContent &&
        Math.floor((conversation.conversation_history || []).length / 2) > (conversation.last_prd_gen_turn || 0),
      prd_gen_error: this.prdGenerator.getStatus(projectId).lastError,
    };
  }

  async generatePrototype(projectId: string): Promise<{ html: string }> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) throw new Error('Project not found');

    const prd = project.prd_content || '(PRD 없음)';
    const design = project.design_content || '(DESIGN 없음)';

    const prompt = `당신은 UI 프로토타이퍼입니다. 아래 PRD와 DESIGN.md를 기반으로 **단일 self-contained HTML 파일**을 생성하세요.

## PRD
${prd}

## DESIGN.md
${design}

## 요구사항
- 모든 CSS/JS를 HTML 파일 안에 인라인으로 포함 (외부 CDN 사용 가능)
- PRD에 언급된 모든 주요 화면/페이지를 구현 (SPA 방식, 탭 또는 사이드바로 전환)
- DESIGN.md의 컬러, 폰트, 컴포넌트 스타일을 충실히 반영
- 실제 데이터는 목 데이터(mock)로 채울 것
- 기능 동작 불필요 (버튼 클릭 시 화면 전환 정도만)
- 모바일/데스크탑 반응형 레이아웃
- 시각적으로 완성도 높게 (프로토타입이 아닌 디자인 목업 수준)

HTML 파일만 출력하고, 설명 텍스트 없이 <!DOCTYPE html>로 시작하는 순수 HTML만 반환하세요.`;

    const response = await this.openai.chat.completions.create({
      model: this.chatModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 8192,
    });

    let html = response.choices[0]?.message?.content ?? '';
    // Strip markdown code fences if present
    html = html.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();

    await this.projectRepo.update(projectId, { prototype_html: html });
    return { html };
  }

  async getPrototype(projectId: string): Promise<string | null> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    return project?.prototype_html || null;
  }

  getScoreTier = getScoreTier;
}
