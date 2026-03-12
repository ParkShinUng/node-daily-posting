import { readFileSync } from 'fs';
import { join } from 'path';
import config from '../config.js';
import logger from '../utils/logger.js';

// 최대 이미지 크기 (base64 기준, ~1MB = 약 1.33MB base64)
const MAX_BASE64_LENGTH = 1400000;
const TARGET_WIDTH = 960;

/**
 * 본문 이미지 생성 스킬
 * ChatGPT DALL-E로 이미지 생성 → 다운로드 → JPEG 압축 → base64 data URI 반환
 * (Tistory 업로드 대신 data URI로 직접 임베드하여 URL 만료 문제 방지)
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

  // 3. 첫 번째 이미지만 다운로드 → JPEG 압축 → base64 data URI 변환
  const dataUris = [];
  try {
    const buffer = await chatgptService.downloadImage(dalleImageUrls[0], page);
    logger.info(`[${category}] 본문 이미지 다운로드 완료`, { size: buffer.length });

    const dataUri = await compressToJpegDataUri(page, buffer, TARGET_WIDTH);
    dataUris.push(dataUri);
    logger.info(`[${category}] 본문 이미지 압축 완료`, { dataUriLength: dataUri.length });
  } catch (error) {
    logger.warn(`[${category}] 본문 이미지 처리 실패`, { error: error.message });
  }

  logger.info(`[${category}] imageGenerator 완료`, { imageCount: dataUris.length });

  return { imageUrls: dataUris };
}

/**
 * PNG Buffer를 JPEG data URI로 압축 변환
 * Playwright 페이지의 canvas API를 사용하여 리사이즈 + JPEG 압축
 */
async function compressToJpegDataUri(page, buffer, targetWidth) {
  const base64Input = buffer.toString('base64');

  const dataUri = await page.evaluate(async ({ base64, targetWidth, maxLength }) => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // 리사이즈: 원본이 targetWidth보다 크면 축소
        let width = img.width;
        let height = img.height;
        if (width > targetWidth) {
          height = Math.round(height * (targetWidth / width));
          width = targetWidth;
        }

        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);

        // JPEG 품질 단계적 조절 (크기 제한 내로)
        const qualities = [0.85, 0.75, 0.65, 0.55, 0.45];
        for (const quality of qualities) {
          const result = canvas.toDataURL('image/jpeg', quality);
          if (result.length <= maxLength) {
            resolve(result);
            return;
          }
        }

        // 최저 품질로도 초과하면 추가 리사이즈
        canvas.width = Math.round(width * 0.7);
        canvas.height = Math.round(height * 0.7);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.5));
      };
      img.onerror = () => reject(new Error('이미지 로드 실패'));
      img.src = `data:image/png;base64,${base64}`;
    });
  }, { base64: base64Input, targetWidth, maxLength: MAX_BASE64_LENGTH });

  return dataUri;
}
