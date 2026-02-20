import { readFileSync } from 'fs';
import { join } from 'path';
import config from '../config.js';
import logger from '../utils/logger.js';

/**
 * 블로그 글 본문 작성 스킬
 * ChatGPT에 프롬프트 전송 → JSON 응답 파싱 → { keyword, title, content, tags }
 */
export async function execute({ brand, productName, category, chatgptService, page }) {
  logger.info(`[${category}] contentWriter 스킬 시작`, { brand, productName });

  // 1. 프롬프트 로드 + 변수 치환
  const promptPath = join(config.paths.config, 'skills', 'contentWriter.json');
  const { prompt: template } = JSON.parse(readFileSync(promptPath, 'utf-8'));

  const prompt = template
    .replace(/{브랜드명}/g, brand)
    .replace(/{상품명}/g, productName);

  // 2. ChatGPT에 프롬프트 전송
  const response = await chatgptService.sendPromptToPage(page, prompt);

  // 3. JSON 파싱 (기존 parseResponse 재활용)
  const result = chatgptService.parseResponse(response);

  logger.info(`[${category}] contentWriter 완료`, {
    keyword: result.keyword,
    title: result.title,
    contentLength: result.content.length,
    tagsCount: result.tags.length,
  });

  return result;
}
