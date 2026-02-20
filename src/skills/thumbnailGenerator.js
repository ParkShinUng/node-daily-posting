import { readFileSync } from 'fs';
import { join } from 'path';
import config from '../config.js';
import logger from '../utils/logger.js';

/**
 * 썸네일 배너 이미지 생성 스킬
 * ChatGPT DALL-E로 썸네일 생성 → 다운로드 → Tistory 업로드
 */
export async function execute({ brand, productName, category, chatgptService, page, tistoryService }) {
  logger.info(`[${category}] thumbnailGenerator 스킬 시작`, { brand, productName });

  // 1. 프롬프트 로드 + 변수 치환
  const promptPath = join(config.paths.config, 'skills', 'thumbnailGenerator.json');
  const { prompt: template } = JSON.parse(readFileSync(promptPath, 'utf-8'));

  const prompt = template
    .replace(/{브랜드명}/g, brand)
    .replace(/{상품명}/g, productName);

  // 2. ChatGPT DALL-E 썸네일 생성
  const dalleImageUrls = await chatgptService.generateImage(page, prompt);

  if (dalleImageUrls.length === 0) {
    throw new Error('썸네일 이미지 생성 실패: 생성된 이미지 없음');
  }

  // 3. 첫 번째 이미지 다운로드 → Tistory 업로드
  const buffer = await chatgptService.downloadImage(dalleImageUrls[0], page);
  const thumbnailUrl = await tistoryService.uploadImage(buffer, `${category}_thumbnail.png`);

  logger.info(`[${category}] thumbnailGenerator 완료`, { thumbnailUrl });

  return { thumbnailUrl };
}
