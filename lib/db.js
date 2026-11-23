/* IndexedDB 封装。后台(service worker)和页面都能用。
 * 库 xbr:items(书签,主键 id)、kv(键值:settings / plan / sync …)。
 * 书签几千条也不会碰到 chrome.storage 的容量限制,而且可以按条读写。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XBR_DB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NAME = 'xbr';
  var VERSION = 1;
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () {
          db.close();
          dbp = null;
        };
        resolve(db);
      };
      req.onerror = function () {
        dbp = null;
        reject(req.error);
      };
    });
    return dbp;
  }

  function reqP(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () {
        res(r.result);
      };
      r.onerror = function () {
        rej(r.error);
      };
    });
  }

  /** 在一个事务里跑 fn(tx);fn 里只能 await IndexedDB 请求,不能 await 别的(否则事务会自动提交)。 */
  async function run(stores, mode, fn) {
    var db = await open();
    return new Promise(function (resolve, reject) {
      var t;
      try {
        t = db.transaction(stores, mode);
      } catch (e) {
        dbp = null;
        reject(e);
        return;
      }
      var result;
      t.oncomplete = function () {
        resolve(result);
      };
      t.onerror = function () {
        reject(t.error);
      };
      t.onabort = function () {
        reject(t.error || new Error('事务中止'));
      };
      Promise.resolve()
        .then(function () {
          return fn(t);
        })
        .then(
          function (r) {
            result = r;
          },
          function (err) {
            try {
              t.abort();
            } catch (_) {}
            reject(err);
          }
        );
    });
  }

  var api = {
    open: open,
    run: run,
    get: function (store, key) {
      return run(store, 'readonly', function (t) {
        return reqP(t.objectStore(store).get(key));
      });
    },
    getMany: function (store, keys) {
      return run(store, 'readonly', function (t) {
        var s = t.objectStore(store);
        return Promise.all(
          keys.map(function (k) {
            return reqP(s.get(k));
          })
        );
      });
    },
    getAll: function (store) {
      return run(store, 'readonly', function (t) {
        return reqP(t.objectStore(store).getAll());
      });
    },
    count: function (store) {
      return run(store, 'readonly', function (t) {
        return reqP(t.objectStore(store).count());
      });
    },
    put: function (store, value, key) {
      return run(store, 'readwrite', function (t) {
        var s = t.objectStore(store);
        return reqP(key === undefined ? s.put(value) : s.put(value, key));
      });
    },
    putMany: function (store, values) {
      if (!values.length) return Promise.resolve();
      return run(store, 'readwrite', function (t) {
        var s = t.objectStore(store);
        for (var i = 0; i < values.length; i++) s.put(values[i]);
      });
    },
    del: function (store, key) {
      return run(store, 'readwrite', function (t) {
        return reqP(t.objectStore(store).delete(key));
      });
    },
    clear: function (store) {
      return run(store, 'readwrite', function (t) {
        return reqP(t.objectStore(store).clear());
      });
    },
    kvGet: async function (key, def) {
      var v = await api.get('kv', key);
      return v === undefined ? def : v;
    },
    kvSet: function (key, value) {
      return api.put('kv', value, key);
    },
    kvDel: function (key) {
      return api.del('kv', key);
    },
  };
  return api;
});
