import { Router, Request, Response, NextFunction } from 'express';
import { ImageService } from '../../../core/roon/ImageService';
import { ErrorResponse } from '../../../shared/types';

/**
 * Create image streaming router
 * Provides artwork streaming by image key
 */
export const createImageRouter = (imageService: ImageService): Router => {
  const router = Router();

  /**
   * GET /api/image/:key
   * Stream artwork by Roon image key
   * Optional query params: scale, width, height
   */
  router.get('/:key', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { key } = req.params;
      const scale = req.query.scale as 'fit' | 'fill' | 'stretch' | undefined;
      const width = req.query.width ? Number(req.query.width) : undefined;
      const height = req.query.height ? Number(req.query.height) : undefined;

      if (!key) {
        const response: ErrorResponse = { error: 'image key required' };
        return res.status(400).json(response);
      }

      // Validate width/height requirements when scale is provided
      if (scale && (!width || !height)) {
        const response: ErrorResponse = {
          error: 'width and height required when scale is specified',
        };
        return res.status(400).json(response);
      }

      const { stream, contentType } = await imageService.getImage(key, scale, width, height);

      // Set cache headers
      const cacheHeaders = imageService.getCacheHeaders();
      Object.entries(cacheHeaders).forEach(([header, value]) => {
        res.set(header, value);
      });

      res.set('Content-Type', contentType);
      stream.pipe(res);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
