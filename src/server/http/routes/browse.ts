import { Router, Request, Response, NextFunction } from 'express';
import { BrowseService } from '../../../core/roon/BrowseService';
import {
  BrowseOptions,
  BrowseLoadOptions,
  BrowsePopOptions,
  BrowseSearchOptions,
  BrowseResult,
  ErrorResponse,
} from '../../../shared/types';

/**
 * Create browse/search router
 * Provides library navigation and search endpoints
 */
export const createBrowseRouter = (browseService: BrowseService): Router => {
  const router = Router();

  /**
   * POST /api/browse
   * Navigate browse hierarchy
   */
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const options = req.body as BrowseOptions;

      if (!options.hierarchy) {
        const response: ErrorResponse = { error: 'hierarchy required' };
        return res.status(400).json(response);
      }

      const result: BrowseResult = await browseService.browse(options);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/browse/load
   * Load additional items within hierarchy
   */
  router.post('/load', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const options = req.body as BrowseLoadOptions;

      if (!options.hierarchy || !options.itemKey) {
        const response: ErrorResponse = { error: 'hierarchy and itemKey required' };
        return res.status(400).json(response);
      }

      const result: BrowseResult = await browseService.load(options);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/browse/pop
   * Go back in browse hierarchy
   */
  router.post('/pop', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const options = req.body as BrowsePopOptions;

      if (!options.hierarchy) {
        const response: ErrorResponse = { error: 'hierarchy required' };
        return res.status(400).json(response);
      }

      const result: BrowseResult = await browseService.pop(options);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/browse/search
   * Search library content
   */
  router.post('/search', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const options = req.body as BrowseSearchOptions;

      if (!options.input) {
        const response: ErrorResponse = { error: 'input (search query) required' };
        return res.status(400).json(response);
      }

      const result = await browseService.search(options);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
