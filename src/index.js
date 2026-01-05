import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import ChatGPTService from './services/chatgpt.js';
import TistoryService from './services/tistory.js';
import config from './config.js';
import logger from './utils/logger.js';

/**
 * 프롬프트 템플릿 로드
 */
function loadPrompt() {
  const promptsPath = join(config.paths.config, 'prompts.json');

  if (!existsSync(promptsPath)) {
    throw new Error('config/prompts.json 파일이 없습니다.');
  }

  const data = readFileSync(promptsPath, 'utf-8');
  const prompts = JSON.parse(data).prompts || [];

  if (prompts.length === 0) {
    throw new Error('설정된 프롬프트가 없습니다.');
  }

  return prompts[0].prompt;
}

/**
 * 글 생성 및 발행
 */
async function generateAndPost() {
  let chatgpt = null;
  let tistory = null;

  try {
    const prompt = loadPrompt();

    logger.info('========================================');
    logger.info('   ChatGPT + Tistory 자동 포스팅');
    logger.info('========================================');

    // ChatGPT 서비스 초기화
    logger.info('[1/4] ChatGPT 초기화 중...');
    chatgpt = new ChatGPTService();
    await chatgpt.initialize();

    // 프롬프트 전송 및 응답 받기
    logger.info('[2/4] 글 생성 중... (최대 5분 소요)');
    const response = await chatgpt.sendPrompt(prompt);

    // 응답 파싱
    const post = chatgpt.parseResponse(response);

    logger.info('========== 생성된 글 ==========');
    logger.info(`키워드: ${post.keyword}`);
    logger.info(`제목: ${post.title}`);
    logger.info(`태그: ${post.tags.join(', ')}`);
    logger.info('================================');

    // Tistory 서비스 초기화
    logger.info('[3/4] Tistory 초기화 중...');
    tistory = new TistoryService();
    await tistory.initialize();

    // 글 발행
    logger.info('[4/4] 글 발행 중...');
    post.visibility = '20';
    post.categoryId = '0';

    const result = await tistory.writePost(post);

    logger.info('발행 완료!');
    logger.info(`URL: ${result.url}`);

  } catch (error) {
    logger.error('작업 실패', { error: error.message });
    process.exit(1);
  } finally {
    if (chatgpt) {
      try { await chatgpt.close(); } catch (e) { logger.error('ChatGPT 종료 실패', { error: e.message }); }
    }
    if (tistory) {
      try { await tistory.close(); } catch (e) { logger.error('Tistory 종료 실패', { error: e.message }); }
    }
  }
}

// 바로 실행
generateAndPost().then(() => {
  process.exit(0);
});
