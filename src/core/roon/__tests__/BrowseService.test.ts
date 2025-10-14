import { BrowseService } from '../BrowseService';
import { RoonClient } from '../RoonClient';
import { Logger } from 'pino';
import { CoreUnpairedError } from '../errors';
import type { BrowseOptions } from '../../../shared/types';

// Mock RoonClient
const mockRoonClient = {
  getTransport: jest.fn(),
  getBrowse: jest.fn(),
  getImage: jest.fn(),
  getCoreInfo: jest.fn(),
  getCoreStatus: jest.fn(),
  on: jest.fn(),
  start: jest.fn(),
} as unknown as RoonClient;

// Mock Logger
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  level: 'info',
} as unknown as Logger;

describe('BrowseService', () => {
  let service: BrowseService;
  let mockBrowse: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockBrowse = {
      browse: jest.fn(),
      load: jest.fn(),
      pop: jest.fn(),
    };
    (mockRoonClient.getBrowse as jest.Mock).mockReturnValue(mockBrowse);
    service = new BrowseService(mockRoonClient, mockLogger);
  });

  describe('browse', () => {
    it('should call browse API and normalize result', async () => {
      const mockResponse = {
        list: {
          title: 'Artists',
          level: 1,
          offset: 0,
          count: 10,
          items: [
            { title: 'Artist 1', item_key: 'key1' },
          ],
        },
      };

      mockBrowse.browse.mockImplementation((_params: any, callback: Function) => {
        callback(null, mockResponse);
      });

      const options: BrowseOptions = { hierarchy: 'browse' };
      const result = await service.browse(options);

      expect(result.title).toBe('Artists');
      expect(result.level).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('Artist 1');
    });

    it('should throw CoreUnpairedError when browse unavailable', async () => {
      (mockRoonClient.getBrowse as jest.Mock).mockReturnValue(null);

      const options: BrowseOptions = { hierarchy: 'browse' };
      await expect(service.browse(options)).rejects.toThrow(CoreUnpairedError);
    });

    it('should reject on browse API error', async () => {
      mockBrowse.browse.mockImplementation((_params: any, callback: Function) => {
        callback(new Error('Browse failed'));
      });

      const options: BrowseOptions = { hierarchy: 'browse' };
      await expect(service.browse(options)).rejects.toThrow('Browse failed');
    });
  });

  describe('search', () => {
    it('should return search results with inferred types', async () => {
      const mockResponse = {
        list: {
          items: [
            { title: 'Track 1', hint: 'track', item_key: 'key1' },
            { title: 'Album 1', hint: 'album', item_key: 'key2' },
          ],
        },
      };

      mockBrowse.browse.mockImplementation((_params: any, callback: Function) => {
        callback(null, mockResponse);
      });

      const results = await service.search({ input: 'test' });

      expect(results).toHaveLength(2);
      expect(results[0].resultType).toBe('track');
      expect(results[1].resultType).toBe('album');
    });
  });
});
