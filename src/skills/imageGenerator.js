import { readFileSync } from 'fs';
import { join } from 'path';
import config from '../config.js';
import logger from '../utils/logger.js';

/**
 * 본문 이미지 생성 스킬
 * ChatGPT DALL-E로 이미지 생성 → 다운로드 → Tistory 업로드
 */
export async function execute({ brand, productName, category, chatgptService, page, tistoryService }) {
  logger.info(`[${category}] imageGenerator 스킬 시작`, { brand, productName });

  // 1. 프롬프트 로드 + 변수 치환
  const promptPath = join(config.paths.config, 'skills', 'imageGenerator.json');
  const { prompt: template } = JSON.parse(readFileSync(promptPath, 'utf-8'));

  const prompt = template
    .replace(/{브랜드명}/g, brand)
    .replace(/{상품명}/g, productName);

  // 2. ChatGPT DALL-E 이미지 생성
  const dalleImageUrls = await chatgptService.generateImage(page, prompt);
  logger.info(`[${category}] DALL-E 이미지 ${dalleImageUrls.length}장 생성 완료`);

  // 3. 다운로드 → Tistory 업로드
  const tistoryUrls = [];
  for (let i = 0; i < dalleImageUrls.length; i++) {
    try {
      const buffer = await chatgptService.downloadImage(dalleImageUrls[i], page);
      const tistoryUrl = await tistoryService.uploadImage(buffer, `${category}_content_${i}.png`);
      tistoryUrls.push(tistoryUrl);
      logger.info(`[${category}] 본문 이미지 ${i + 1} 업로드 완료`, { tistoryUrl });
    } catch (error) {
      logger.warn(`[${category}] 본문 이미지 ${i + 1} 업로드 실패`, { error: error.message });
    }
  }

  logger.info(`[${category}] imageGenerator 완료`, { imageCount: tistoryUrls.length });

  return { imageUrls: tistoryUrls };
}
