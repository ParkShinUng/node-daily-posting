import { readFileSync } from 'fs';
import { join } from 'path';
import config from '../config.js';
import logger from '../utils/logger.js';
import { delay } from '../utils/helpers.js';

const MIN_CONTENT_LENGTH = 500;
const MAX_RETRIES = 3;

/**
 * 블로그 글 본문 작성 스킬
 * ChatGPT에 프롬프트 전송 → JSON 응답 파싱 → { keyword, title, content, tags }
 * 짧은 응답/파싱 실패 시 새 대화로 재시도 (최대 3회)
 */
export async function execute({ brand, productName, category, chatgptService, page }) {
  logger.info(`[${category}] contentWriter 스킬 시작`, { brand, productName });

  // 1. 프롬프트 로드 + 변수 치환
  const promptPath = join(config.paths.config, 'skills', 'contentWriter.json');
  const { prompt: template } = JSON.parse(readFileSync(promptPath, 'utf-8'));

  const prompt = template
    .replace(/{브랜드명}/g, brand)
    .replace(/{상품명}/g, productName);

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 재시도 시 새 대화 시작
      if (attempt > 1) {
        logger.info(`[${category}] 새 대화로 재시도 (${attempt}/${MAX_RETRIES})`);
        await chatgptService.startNewChat(page);
        await delay(2000);
      }

      // 2. ChatGPT에 프롬프트 전송
      const response = await chatgptService.sendPromptToPage(page, prompt);

      // 응답 길이 검증 — 블로그 JSON은 최소 500자 이상이어야 함
      if (!response || response.length < MIN_CONTENT_LENGTH) {
        const preview = response?.substring(0, 100) || '(빈 응답)';
        logger.warn(`[${category}] 응답이 너무 짧음 (${response?.length || 0}자), 시도 ${attempt}/${MAX_RETRIES}`, { preview });
        throw new Error(`응답이 너무 짧습니다 (${response?.length || 0}자)`);
      }

      // 3. JSON 파싱
      const result = chatgptService.parseResponse(response);

      logger.info(`[${category}] contentWriter 완료`, {
        keyword: result.keyword,
        title: result.title,
        contentLength: result.content.length,
        tagsCount: result.tags.length,
      });

      return result;
    } catch (error) {
      lastError = error;
      logger.warn(`[${category}] contentWriter 시도 ${attempt}/${MAX_RETRIES} 실패`, { error: error.message });

      if (attempt < MAX_RETRIES) {
        await delay(3000);
      }
    }
  }

  throw lastError;
}
