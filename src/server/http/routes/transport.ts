import { Router, Request, Response, NextFunction } from 'express';
import { TransportService } from '../../../core/roon/TransportService';
import {
  TransportControlRequest,
  SeekRequest,
  VolumeRequest,
  SuccessResponse,
  ErrorResponse,
} from '../../../shared/types';

/**
 * Create transport control router
 * Provides playback control endpoints
 */
export const createTransportRouter = (transportService: TransportService): Router => {
  const router = Router();

  /**
   * POST /api/transport/play-pause
   * Toggle play/pause for a zone
   */
  router.post('/play-pause', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zone_id } = req.body as TransportControlRequest;

      if (!zone_id) {
        const response: ErrorResponse = { error: 'zone_id required' };
        return res.status(400).json(response);
      }

      await transportService.playPause(zone_id);

      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/transport/next
   * Skip to next track
   */
  router.post('/next', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zone_id } = req.body as TransportControlRequest;

      if (!zone_id) {
        const response: ErrorResponse = { error: 'zone_id required' };
        return res.status(400).json(response);
      }

      await transportService.next(zone_id);

      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/transport/previous
   * Skip to previous track
   */
  router.post('/previous', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zone_id } = req.body as TransportControlRequest;

      if (!zone_id) {
        const response: ErrorResponse = { error: 'zone_id required' };
        return res.status(400).json(response);
      }

      await transportService.previous(zone_id);

      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/transport/stop
   * Stop playback
   */
  router.post('/stop', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zone_id } = req.body as TransportControlRequest;

      if (!zone_id) {
        const response: ErrorResponse = { error: 'zone_id required' };
        return res.status(400).json(response);
      }

      await transportService.stop(zone_id);

      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/transport/seek
   * Seek to position in current track
   */
  router.post('/seek', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zone_id, seconds } = req.body as SeekRequest;

      if (!zone_id || seconds === undefined) {
        const response: ErrorResponse = { error: 'zone_id and seconds required' };
        return res.status(400).json(response);
      }

      await transportService.seek(zone_id, seconds);

      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/transport/volume
   * Set volume for an output
   */
  router.post('/volume', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { output_id, value } = req.body as VolumeRequest;

      if (!output_id || value === undefined) {
        const response: ErrorResponse = { error: 'output_id and value required' };
        return res.status(400).json(response);
      }

      await transportService.setVolume(output_id, value);

      const response: SuccessResponse = { success: true };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
