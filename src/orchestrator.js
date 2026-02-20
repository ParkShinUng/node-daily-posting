import * as contentWriter from './skills/contentWriter.js';
import * as imageGenerator from './skills/imageGenerator.js';
import * as thumbnailGenerator from './skills/thumbnailGenerator.js';
import logger from './utils/logger.js';

/**
 * 상품 1개에 대한 전체 파이프라인 오케스트레이터
 *
 * 카테고리당 ChatGPT 탭 2개 사용 (병렬 실행):
 *   Tab A: 글 본문 작성
 *   Tab B: 본문 이미지 → 새 대화 → 썸네일
 *
 * 카테고리 간에는 병렬 (Promise.allSettled)
 */
export async function orchestrate({ product, chatgptService, tistoryService }) {
  const { category, brand, productName } = product;
  const contentPageId = `${category}-content`;
  const imagePageId = `${category}-image`;

  logger.info(`[${category}] 오케스트레이터 시작 (병렬 모드)`, { brand, productName });

  // ChatGPT 탭 2개 생성
  const contentPage = await chatgptService.createPage(contentPageId);
  const imagePage = await chatgptService.createPage(imagePageId);

  try {
    // ===== 병렬 실행: 글 작성 ∥ (이미지 + 썸네일) =====
    logger.info(`[${category}] 병렬 실행 시작 — Tab A: 글 본문 / Tab B: 이미지+썸네일`);

    const [contentResult, imageResults] = await Promise.all([
      // Tab A: 글 본문 작성
      (async () => {
        logger.info(`[${category}] [Tab A] 글 본문 작성 시작`);
        const result = await contentWriter.execute({
          brand, productName, category, chatgptService, page: contentPage,
        });
        logger.info(`[${category}] [Tab A] 글 본문 작성 완료`);
        return result;
      })(),

      // Tab B: 이미지 → 썸네일 (같은 탭에서 순차)
      (async () => {
        let imgResult = { imageUrls: [] };
        let thumbResult = { thumbnailUrl: '' };

        try {
          logger.info(`[${category}] [Tab B] 본문 이미지 생성 시작`);
          imgResult = await imageGenerator.execute({
            brand, productName, category, chatgptService, page: imagePage, tistoryService,
          });
          logger.info(`[${category}] [Tab B] 본문 이미지 생성 완료`);
        } catch (error) {
          logger.warn(`[${category}] [Tab B] 본문 이미지 생성 실패, 이미지 없이 진행`, { error: error.message });
        }

        try {
          await chatgptService.startNewChat(imagePage);
          logger.info(`[${category}] [Tab B] 썸네일 생성 시작`);
          thumbResult = await thumbnailGenerator.execute({
            brand, productName, category, chatgptService, page: imagePage, tistoryService,
          });
          logger.info(`[${category}] [Tab B] 썸네일 생성 완료`);
        } catch (error) {
          logger.warn(`[${category}] [Tab B] 썸네일 생성 실패, 썸네일 없이 진행`, { error: error.message });
        }

        return { ...imgResult, ...thumbResult };
      })(),
    ]);

    logger.info(`[${category}] 모든 스킬 완료`, {
      title: contentResult.title,
      imageCount: imageResults.imageUrls?.length || 0,
      hasThumbnail: !!imageResults.thumbnailUrl,
    });

    // ===== 결과 결합: 본문에 이미지 삽입 =====
    const finalContent = combineContent(contentResult.content, imageResults.imageUrls);

    // ===== Tistory 발행 =====
    const postUrl = await tistoryService.writePost({
      title: contentResult.title,
      content: finalContent,
      tags: contentResult.tags,
      thumbnailUrl: imageResults.thumbnailUrl || '',
      visibility: '20',
      categoryId: '1292960',
    });

    logger.info(`[${category}] 발행 완료!`, { postUrl });

    return {
      category,
      success: true,
      postUrl,
      title: contentResult.title,
    };

  } catch (error) {
    logger.error(`[${category}] 오케스트레이터 실패`, { error: error.message });
    throw error;
  } finally {
    await chatgptService.closePage(contentPageId);
    await chatgptService.closePage(imagePageId);
    logger.info(`[${category}] ChatGPT 탭 2개 정리 완료`);
  }
}

/**
 * HTML 본문에 이미지를 적절한 위치에 삽입
 * - 각 <h2> 태그 앞에 이미지 1장씩 배치
 */
function combineContent(htmlContent, imageUrls) {
  if (!imageUrls || imageUrls.length === 0) return htmlContent;

  const h2Regex = /<h2[^>]*>/g;
  const matches = [];
  let match;

  while ((match = h2Regex.exec(htmlContent)) !== null) {
    matches.push(match.index);
  }

  if (matches.length === 0) return htmlContent;

  // 뒤에서부터 삽입 (offset 계산 불필요)
  let result = htmlContent;
  const insertCount = Math.min(imageUrls.length, matches.length);

  for (let i = insertCount - 1; i >= 0; i--) {
    const imgTag = `<figure style="text-align:center;margin:24px 0;"><img src="${imageUrls[i]}" alt="${i === 0 ? '제품 이미지' : '제품 상세 이미지'}" style="width:100%;max-width:720px;border-radius:12px;" /></figure>\n`;
    result = result.slice(0, matches[i]) + imgTag + result.slice(matches[i]);
  }

  return result;
}
