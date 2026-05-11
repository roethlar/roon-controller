import { BrowseService } from '../BrowseService';
import { RoonClient } from '../RoonClient';
import { Logger } from 'pino';
import { CoreUnpairedError } from '../errors';
import type { BrowseOptions, BrowsePopOptions } from '../../../shared/types';

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
  trace: jest.fn(),
  level: 'info',
} as unknown as Logger;

describe('BrowseService', () => {
  let service: BrowseService;
  let mockBrowseApi: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockBrowseApi = {
      browse: jest.fn(),
      load: jest.fn(),
    };
    (mockRoonClient.getBrowse as jest.Mock).mockReturnValue(mockBrowseApi);
    service = new BrowseService(mockRoonClient, mockLogger);
  });

  describe('browse', () => {
    it('should call browse then load and return normalized items', async () => {
      // Roon browse() returns list metadata (no items)
      const browseResponse = {
        action: 'list',
        list: {
          title: 'Artists',
          level: 1,
          count: 2,
        },
      };

      // Roon load() returns items at the top level
      const loadResponse = {
        items: [
          { title: 'Artist 1', item_key: 'key1', hint: 'list' },
          { title: 'Artist 2', item_key: 'key2', hint: 'list' },
        ],
        offset: 0,
        list: { title: 'Artists', level: 1, count: 2 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      const options: BrowseOptions = { hierarchy: 'browse' };
      const result = await service.browse(options);

      expect(mockBrowseApi.browse).toHaveBeenCalledTimes(1);
      expect(mockBrowseApi.load).toHaveBeenCalledTimes(1);
      expect(result.title).toBe('Artists');
      expect(result.level).toBe(1);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].title).toBe('Artist 1');
      expect(result.items[0].itemKey).toBe('key1');
    });

    it('should not call load when browse returns action other than list', async () => {
      const browseResponse = {
        action: 'message',
        message: 'Done',
        is_error: false,
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });

      const result = await service.browse({ hierarchy: 'browse' });

      expect(mockBrowseApi.load).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(0);
    });

    it('should not call load when list count is 0', async () => {
      const browseResponse = {
        action: 'list',
        list: { title: 'Empty', level: 0, count: 0 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });

      const result = await service.browse({ hierarchy: 'browse' });

      expect(mockBrowseApi.load).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('should throw CoreUnpairedError when browse unavailable', async () => {
      (mockRoonClient.getBrowse as jest.Mock).mockReturnValue(null);

      await expect(service.browse({ hierarchy: 'browse' })).rejects.toThrow(CoreUnpairedError);
    });

    it('should reject on browse API error', async () => {
      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(new Error('Browse failed'));
      });

      await expect(service.browse({ hierarchy: 'browse' })).rejects.toThrow('Browse failed');
    });

    it('should pass item_key for drill-down navigation', async () => {
      const browseResponse = {
        action: 'list',
        list: { title: 'Albums', level: 2, count: 1 },
      };
      const loadResponse = {
        items: [{ title: 'Track 1', item_key: 't1', hint: 'action' }],
        offset: 0,
        list: { title: 'Albums', level: 2, count: 1 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      await service.browse({ hierarchy: 'browse', itemKey: 'album_key' });

      expect(mockBrowseApi.browse).toHaveBeenCalledWith(
        expect.objectContaining({ item_key: 'album_key' }),
        expect.any(Function)
      );
    });

    it('should preserve zone and multi-session context when loading browse items', async () => {
      const browseResponse = {
        action: 'list',
        list: { title: 'Search Result', level: 1, count: 1 },
      };
      const loadResponse = {
        items: [{ title: 'Album 1', item_key: 'album1', hint: 'list' }],
        offset: 0,
        list: { title: 'Search Result', level: 1, count: 1 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      await service.browse({
        hierarchy: 'search',
        itemKey: 'album_key',
        zoneId: 'zone123',
        multiSessionKey: 'library-search',
      });

      expect(mockBrowseApi.browse).toHaveBeenCalledWith(
        expect.objectContaining({
          hierarchy: 'search',
          item_key: 'album_key',
          zone_or_output_id: 'zone123',
          multi_session_key: 'library-search',
        }),
        expect.any(Function)
      );
      expect(mockBrowseApi.load).toHaveBeenCalledWith(
        expect.objectContaining({
          hierarchy: 'search',
          zone_or_output_id: 'zone123',
          multi_session_key: 'library-search',
        }),
        expect.any(Function)
      );
    });
  });

  describe('browse pagination', () => {
    it('loads only the first page (PAGE_SIZE=100) by default for large lists', async () => {
      const totalCount = 350;
      const browseResponse = {
        action: 'list',
        list: { title: 'Big', level: 1, count: totalCount },
      };
      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      // Each load() returns the requested batch; we just need to count calls.
      mockBrowseApi.load.mockImplementation((params: any, cb: Function) => {
        const items = Array.from({ length: params.count }, (_, i) => ({
          title: `Item ${params.offset + i}`,
          item_key: `k${params.offset + i}`,
        }));
        cb(false, { items, offset: params.offset, list: { count: totalCount, level: 1 } });
      });

      const result = await service.browse({ hierarchy: 'browse' });

      // One browse() + one load() (first page only).
      expect(mockBrowseApi.browse).toHaveBeenCalledTimes(1);
      expect(mockBrowseApi.load).toHaveBeenCalledTimes(1);
      expect(result.items).toHaveLength(100);
      expect(result.totalCount).toBe(totalCount);
    });

    it('loads the entire list when pageSize is Infinity', async () => {
      const totalCount = 250;
      const browseResponse = {
        action: 'list',
        list: { title: 'Big', level: 1, count: totalCount },
      };
      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((params: any, cb: Function) => {
        const items = Array.from({ length: params.count }, (_, i) => ({
          title: `Item ${params.offset + i}`,
          item_key: `k${params.offset + i}`,
        }));
        cb(false, { items, offset: params.offset, list: { count: totalCount, level: 1 } });
      });

      const result = await service.browse({ hierarchy: 'browse', pageSize: Infinity });

      // Three load() calls for 250 items at PAGE_SIZE=100.
      expect(mockBrowseApi.load).toHaveBeenCalledTimes(3);
      expect(result.items).toHaveLength(totalCount);
    });

    it('clamps pageSize to MAX_COUNT so a single browse call cannot chain unbounded loads', async () => {
      // 10,000-item list, caller asks for pageSize=Infinity. The
      // service must cap at MAX_COUNT (5_000) — i.e. 50 page calls
      // at PAGE_SIZE=100, not 100. Without the clamp a malicious or
      // buggy client could ask the backend to chain 100+ sequential
      // load() round-trips against Roon.
      const totalCount = 10_000;
      const browseResponse = {
        action: 'list',
        list: { title: 'Huge', level: 1, count: totalCount },
      };
      mockBrowseApi.browse.mockImplementation((_p: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((params: any, cb: Function) => {
        const items = Array.from({ length: params.count }, (_, i) => ({
          title: `Item ${params.offset + i}`,
          item_key: `k${params.offset + i}`,
        }));
        cb(false, { items, offset: params.offset, list: { count: totalCount, level: 1 } });
      });

      const result = await service.browse({ hierarchy: 'browse', pageSize: Infinity });

      // 5_000 items loaded in 50 pages of 100.
      expect(mockBrowseApi.load).toHaveBeenCalledTimes(50);
      expect(result.items).toHaveLength(5_000);
    });
  });

  describe('pop', () => {
    it('should call browse with pop_levels then load items', async () => {
      const browseResponse = {
        action: 'list',
        list: { title: 'Root', level: 0, count: 3 },
      };
      const loadResponse = {
        items: [
          { title: 'Item 1', item_key: 'k1', hint: 'list' },
          { title: 'Item 2', item_key: 'k2', hint: 'list' },
          { title: 'Item 3', item_key: 'k3', hint: 'list' },
        ],
        offset: 0,
        list: { title: 'Root', level: 0, count: 3 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      const options: BrowsePopOptions = { hierarchy: 'browse', levels: 2 };
      const result = await service.pop(options);

      // Pop uses browse() with pop_levels, NOT a separate pop method
      expect(mockBrowseApi.browse).toHaveBeenCalledWith(
        expect.objectContaining({ hierarchy: 'browse', pop_levels: 2 }),
        expect.any(Function)
      );
      expect(result.items).toHaveLength(3);
    });

    it('should default to pop_levels 1', async () => {
      const browseResponse = { action: 'list', list: { level: 0, count: 0 } };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });

      await service.pop({ hierarchy: 'browse' });

      expect(mockBrowseApi.browse).toHaveBeenCalledWith(
        expect.objectContaining({ pop_levels: 1 }),
        expect.any(Function)
      );
    });

    it('should pass multi-session context when popping a browse stack', async () => {
      const browseResponse = { action: 'list', list: { level: 0, count: 0 } };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });

      await service.pop({ hierarchy: 'search', multiSessionKey: 'library-search' });

      expect(mockBrowseApi.browse).toHaveBeenCalledWith(
        expect.objectContaining({
          hierarchy: 'search',
          pop_levels: 1,
          multi_session_key: 'library-search',
        }),
        expect.any(Function)
      );
    });
  });

  describe('load', () => {
    it('should call load API and normalize items from top-level response', async () => {
      const loadResponse = {
        items: [
          { title: 'Item A', item_key: 'a', hint: 'list' },
        ],
        offset: 0,
        list: { title: 'Browse', level: 0, count: 5 },
      };

      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      const result = await service.load({ hierarchy: 'browse', offset: 0 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('Item A');
      expect(result.count).toBe(5);
    });
  });

  describe('search', () => {
    it('should return search results with inferred types', async () => {
      const browseResponse = {
        action: 'list',
        list: { level: 0, count: 2 },
      };
      const loadResponse = {
        items: [
          { title: 'Track 1', hint: 'action', item_key: 'key1' },
          { title: 'Album 1', hint: 'list', item_key: 'key2' },
        ],
        offset: 0,
        list: { level: 0, count: 2 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      const results = await service.search({ input: 'test' });

      expect(results).toHaveLength(2);
      // hint "action" doesn't match any search type category
      expect(results[0].resultType).toBe('unknown');
    });

    it('should search in the provided multi-session context', async () => {
      const browseResponse = {
        action: 'list',
        list: { level: 0, count: 1 },
      };
      const loadResponse = {
        items: [{ title: 'Album 1', hint: 'list', item_key: 'key1' }],
        offset: 0,
        list: { level: 0, count: 1 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      await service.search({
        input: 'test',
        zoneId: 'zone123',
        multiSessionKey: 'library-search',
      });

      expect(mockBrowseApi.browse).toHaveBeenCalledWith(
        expect.objectContaining({
          hierarchy: 'search',
          input: 'test',
          zone_or_output_id: 'zone123',
          multi_session_key: 'library-search',
          pop_all: true,
        }),
        expect.any(Function)
      );
      expect(mockBrowseApi.load).toHaveBeenCalledWith(
        expect.objectContaining({
          hierarchy: 'search',
          zone_or_output_id: 'zone123',
          multi_session_key: 'library-search',
        }),
        expect.any(Function)
      );
    });
  });
});
