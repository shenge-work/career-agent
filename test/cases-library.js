/* 多简历仓库（js/store/resume-library.js）测试。
   与 cases-audit.js 同构：CommonJS，由运行器在 Node 侧 require 后逐条执行，
   通过 ctx.ResumeLibrary（vm 上下文里的 window.ResumeLibrary）访问，断言走 ctx.assert。

   覆盖：索引清单排序、create/duplicate/remove/rename 的元数据流转、
   文档读写往返、激活态持久化、空库继承首份。依赖运行器注入的内存 indexedDB 桩。 */

'use strict';

module.exports = [
  {
    name: '空库初始化返回 count=0 且无激活 id',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.init().then((r) => {
        ctx.assert(r.count === 0, '空库 init 返回 count=0');
        ctx.assert(!r.activeId, '空库 init 无激活 id');
      });
    }
  },
  {
    name: 'create 新建并成为激活简历、写入索引与文档',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.create({ title: '测试简历', payload: { data: { name: '张三', contact: [], sections: [] }, fonts: null, spacing: null, v: 8 } })
        .then((meta) => {
          ctx.assert(!!meta.id && meta.id.indexOf('res_') === 0, '生成的 id 带 res_ 前缀');
          ctx.assert(meta.title === '测试简历', '标题正确');
          return L.list();
        }).then((idx) => {
          ctx.assert(idx.length === 1, '列表含 1 份');
          ctx.assert(idx[0].title === '测试简历', '列表标题正确');
          return L.load(idx[0].id);
        }).then((doc) => {
          ctx.assert(!!doc && doc.data && doc.data.name === '张三', '文档可往返读取');
        });
    }
  },
  {
    name: 'list 按 updatedAt 倒序排列',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.create({ title: '较早', payload: { data: { name: 'a', contact: [], sections: [] } } })
        .then(() => new Promise(r => setTimeout(r, 20)))
        .then(() => L.create({ title: '较晚', payload: { data: { name: 'b', contact: [], sections: [] } } }))
        .then(() => L.list())
        .then((idx) => {
          ctx.assert(idx.length >= 2, '至少两份');
          // 倒序：updatedAt 最大的在前
          for (let i = 1; i < idx.length; i++) {
            if (idx[i-1].updatedAt < idx[i].updatedAt) { ctx.assert(false, 'updatedAt 严格降序（第' + i + '项）'); return; }
          }
          ctx.assert(true, 'updatedAt 严格降序');
          ctx.assert(idx[0].title === '较晚', '最新在前');
        });
    }
  },
  {
    name: 'duplicate 复制出带「副本」后缀的新简历且内容一致',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.list().then((idx) => {
        const src = idx[0];
        return L.duplicate(src.id).then((meta) => {
          ctx.assert(meta.id !== src.id, '复制生成新 id');
          ctx.assert(meta.title === src.title + ' 副本', '副本标题带后缀');
          return Promise.all([L.load(src.id), L.load(meta.id)]);
        }).then(([a, b]) => {
          ctx.assert(JSON.stringify(a.data) === JSON.stringify(b.data), '副本内容与源一致');
        });
      });
    }
  },
  {
    name: 'rename 更新标题',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.list().then((idx) => {
        const id = idx[0].id;
        return L.rename(id, '新名字').then(() => L.list());
      }).then((idx) => {
        ctx.assert(idx.some(m => m.title === '新名字'), 'rename 后标题更新');
      });
    }
  },
  {
    name: 'setActive/getActive 持久化激活态',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.list().then((idx) => {
        const id = idx[0].id;
        return L.setActive(id).then(() => L.getActive());
      }).then((act) => {
        ctx.assert(!!act, '激活态已写入并读回');
      });
    }
  },
  {
    name: 'remove 删除简历并从索引移除',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.list().then((idx) => {
        const before = idx.length;
        const id = idx[0].id;
        return L.remove(id).then(() => L.list()).then((after) => {
          ctx.assert(after.length === before - 1, '删除后数量减一');
          ctx.assert(!after.some(m => m.id === id), '被删 id 不再出现');
          return L.load(id);
        }).then((doc) => {
          ctx.assert(doc === null, '被删文档已清空');
        });
      });
    }
  },
  {
    name: 'save 更新文档内容与 updatedAt',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.list().then((idx) => {
        const id = idx[0].id;
        const payload = { data: { name: '改后', contact: [], sections: [] }, fonts: null, spacing: null, v: 8 };
        return L.save(id, payload).then(() => L.load(id));
      }).then((doc) => {
        ctx.assert(doc.data.name === '改后', 'save 后内容更新');
      });
    }
  },
  {
    name: 'rename 只改索引标题，正文文件（按 id）不受影响',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.list().then((idx) => {
        const id = idx[0].id;
        const before = idx[0].title;
        return L.rename(id, '更名后标题').then(() => Promise.all([L.list(), L.load(id)]));
      }).then(([idx, doc]) => {
        const m = idx.find(x => x.title === '更名后标题');
        ctx.assert(!!m, 'rename 后索引标题更新');
        ctx.assert(!!doc && !!doc.data, 'rename 后文档仍可按原 id 读取');
        ctx.assert(doc.data.name === '改后', 'rename 不触碰正文内容');
      });
    }
  },
  {
    name: 'save 带 meta.lastHash 后 getMeta/patchMeta 可读回指纹',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      let savedId = null;
      return L.list().then((idx) => {
        savedId = idx[0].id;
        return L.save(savedId, { data: { name: '带指纹', contact: [], sections: [] }, fonts: null, spacing: null, v: 8 }, { lastHash: 'HASH_ABC' });
      }).then(() => {
        const m = ctx.ResumeLibrary.getMeta(savedId);
        ctx.assert(!!m && m.lastHash === 'HASH_ABC', 'save 透传 lastHash 到索引项');
        return L.patchMeta(savedId, { lastHash: 'HASH_XYZ' });
      }).then(() => {
        ctx.assert(ctx.ResumeLibrary.getMeta(savedId).lastHash === 'HASH_XYZ', 'patchMeta 可更新指纹');
      });
    }
  },

  /* ---- savedAt 新旧仲裁（数据一致性根治，2026-09-19）----
     pickResumeSource(doc, memSavedAt)：库文档与内存基底谁新用谁。
     旧数据双方无 savedAt（都 0）→ 'repo'（磁盘优先，是恢复脚本/手工编辑的意图载体）。 */
  {
    name: '仲裁：库文档 savedAt 较新 → library（浏览器有未落盘修改）',
    fn: (ctx) => {
      const pick = ctx.pickResumeSource;
      ctx.assert(!!pick, 'pickResumeSource 已导出');
      ctx.assert(pick({ savedAt: 2000, data: {} }, 1000) === 'library', '库 2000 > 内存 1000 → library');
    }
  },
  {
    name: '仲裁：内存基底较新 → repo（磁盘优先回写库）',
    fn: (ctx) => {
      const pick = ctx.pickResumeSource;
      ctx.assert(pick({ savedAt: 1000, data: {} }, 2000) === 'repo', '库 1000 < 内存 2000 → repo');
      ctx.assert(pick({ savedAt: 1000, data: {} }, 1000) === 'repo', '同级 → repo（不覆盖）');
    }
  },
  {
    name: '仲裁：旧数据无 savedAt → repo（磁盘是意图载体）',
    fn: (ctx) => {
      const pick = ctx.pickResumeSource;
      ctx.assert(pick({ data: {} }, 0) === 'repo', '双方均无时间戳 → repo');
      ctx.assert(pick({ savedAt: 500, data: {} }, 0) === 'library', '库有内存无 → library');
      ctx.assert(pick(null, 123) === 'repo', 'doc 为 null → repo');
      ctx.assert(pick({ savedAt: 'abc', data: {} }, 0) === 'repo', '非法时间戳按 0 处理 → repo');
    }
  },

  /* ---- 简历血缘（Resume Matcher master→tailored，2026-09-21）----
     meta 新增 parentId / kind / jobId / jdText，派生版可回溯到母简历并持久化 JD。 */
  {
    name: 'create 缺省 kind=master 且不携带血缘字段',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.create({ title: '母简历', payload: { data: { name: 'x', contact: [], sections: [] } } }).then((meta) => {
        const m = L.getMeta(meta.id);
        ctx.assert(m.kind === 'master', '缺省 kind=master');
        ctx.assert(m.parentId === undefined, '缺省无 parentId');
        ctx.assert(m.jobId === undefined, '缺省无 jobId');
      });
    }
  },
  {
    name: 'derive 生成 kind=derived 且 parentId 指向母简历',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.create({ title: '母简历', payload: { data: { name: '母', contact: [], sections: [] } } }).then((master) => {
        return L.derive({ parentId: master.id, title: '母简历 · 定制', jobId: 'jd_abc', jdText: 'Java 工程师 JD' }).then((d) => {
          const m = L.getMeta(d.id);
          ctx.assert(d.id !== master.id, '派生生成新 id');
          ctx.assert(m.kind === 'derived', '派生版 kind=derived');
          ctx.assert(m.parentId === master.id, 'parentId 指向母简历');
          ctx.assert(m.jobId === 'jd_abc', 'jobId 关联 JD');
          ctx.assert(m.jdText === 'Java 工程师 JD', 'jdText 存 JD 原文');
        });
      });
    }
  },
  {
    name: 'children 列出母简历的全部派生版',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.create({ title: '母A', payload: { data: { name: 'a', contact: [], sections: [] } } }).then((master) => {
        return L.derive({ parentId: master.id, title: '派生1' })
          .then(() => L.derive({ parentId: master.id, title: '派生2' }))
          .then(() => L.children(master.id))
          .then((kids) => {
            ctx.assert(kids.length === 2, '母简历有 2 个派生版');
            ctx.assert(kids.every(k => k.parentId === master.id), '每个派生版 parentId 正确');
          });
      });
    }
  },
  {
    name: 'derive 缺 parentId 抛错（血缘锚点必填）',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.derive({ title: '无母版' }).then(
        () => { ctx.assert(false, '缺 parentId 应抛错'); },
        (e) => { ctx.assert(/parentId/.test(String(e && e.message)), '抛错提示 parentId'); }
      );
    }
  },
  {
    name: 'save/patchMeta 白名单透传血缘字段',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      let id = null;
      return L.create({ title: '血缘测试', payload: { data: { name: 'x', contact: [], sections: [] } } }).then((meta) => {
        id = meta.id;
        return L.save(id, { data: { name: 'x', contact: [], sections: [] } }, { parentId: 'res_parent', kind: 'derived', jobId: 'jd_x', jdText: 'JD 原文' });
      }).then(() => {
        const m = L.getMeta(id);
        ctx.assert(m.parentId === 'res_parent', 'save 透传 parentId');
        ctx.assert(m.kind === 'derived', 'save 透传 kind');
        ctx.assert(m.jobId === 'jd_x', 'save 透传 jobId');
        ctx.assert(m.jdText === 'JD 原文', 'save 透传 jdText');
        return L.patchMeta(id, { kind: 'master', jdText: '改了' });
      }).then(() => {
        const m = L.getMeta(id);
        ctx.assert(m.kind === 'master', 'patchMeta 可改 kind');
        ctx.assert(m.jdText === '改了', 'patchMeta 可改 jdText');
      });
    }
  },
  {
    name: 'kind 非法值归一化为 master',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      return L.create({ title: 'k', payload: { data: { name: 'x', contact: [], sections: [] } }, kind: 'bogus' }).then((meta) => {
        ctx.assert(L.getMeta(meta.id).kind === 'master', '非法 kind 归一化为 master');
      });
    }
  },
  /* ---------- N3 分享与权限控制：meta 白名单 + 删除撤销 ---------- */
  {
    name: 'N3：save / patchMeta 透传 isLocked / isPublic / shareToken',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      let id = null;
      const payload = { data: { name: 'x', contact: [], sections: [] } };
      return L.create({ title: '权限测试', payload: payload }).then((meta) => {
        id = meta.id;
        /* 新建的简历默认既没锁定也没分享（字段缺省即 false） */
        ctx.assert(!L.getMeta(id).isLocked, '新建默认未锁定');
        ctx.assert(!L.getMeta(id).isPublic, '新建默认未分享');
        return L.save(id, payload, { isLocked: true, isPublic: true, shareToken: 'tok_1' });
      }).then(() => {
        const m = L.getMeta(id);
        ctx.assert(m.isLocked === true, 'save 透传 isLocked');
        ctx.assert(m.isPublic === true, 'save 透传 isPublic');
        ctx.assert(m.shareToken === 'tok_1', 'save 透传 shareToken');
        /* 局部写场景：patchMeta 不应把没提到的字段清掉 */
        return L.patchMeta(id, { isLocked: false });
      }).then(() => {
        const m = L.getMeta(id);
        ctx.assert(m.isLocked === false, 'patchMeta 可解锁');
        ctx.assert(m.isPublic === true, '⚠️ 未提及的字段不受影响（isPublic 保持 true）');
        ctx.assert(m.shareToken === 'tok_1', '⚠️ 未提及的 shareToken 不被清掉');
        return L.patchMeta(id, { shareToken: null });
      }).then(() => {
        ctx.assert(L.getMeta(id).shareToken === null, '关闭分享时 shareToken 可显式置空');
      });
    }
  },
  {
    name: 'N3：删除进撤销栈，undoRemove 原样找回（含正文与 id）',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      let id = null;
      const payload = { data: { name: '被删的人', contact: [], sections: [{ id: 's1', type: 'custom', title: 'X' }] } };
      return L.create({ title: '待删除', payload: payload }).then((meta) => {
        id = meta.id;
        return L.patchMeta(id, { isLocked: true, shareToken: 'tok_keep' });
      }).then(() => {
        L.beginRemoveBatch();
        return L.remove(id);
      }).then(() => L.list()).then((idx) => {
        ctx.assert(idx.filter((m) => m.id === id).length === 0, '删除后索引里没有它');
        const peek = L.peekRemoved();
        ctx.assert(peek.length === 1 && peek[0].id === id, '撤销栈里留了它（peekRemoved）');
        ctx.assert(peek[0].isLocked === true, '撤销栈里的 meta 保留锁定状态');
        return L.undoRemove();
      }).then((restored) => {
        ctx.assert(restored.length === 1 && restored[0].id === id, 'undoRemove 复用**原 id**（血缘 / 同步分键都锚在 id 上）');
        ctx.assert(restored[0].shareToken === 'tok_keep', '恢复后分享标识还在');
        ctx.assert(L.peekRemoved().length === 0, '撤销后栈清空（不能重复撤销）');
        return L.load(id);
      }).then((doc) => {
        ctx.assert(!!doc && doc.data && doc.data.name === '被删的人', '正文一并恢复（不是空壳）');
        ctx.assert(doc.data.sections.length === 1, '正文里的板块也回来了');
        return L.undoRemove();
      }).then((again) => {
        ctx.assert(again.length === 0, '没有可撤销内容时返回空数组（幂等）');
      });
    }
  },
  /* ---------- 主简历（源头简历唯一标识，2026-09-22）----------
     isMaster 经 meta 白名单透传、setMaster 互斥、list 主在前、init 自动播种源头简历。
     ⚠️ 与文件内其它用例共享 ctx.ResumeLibrary 索引会相互污染（先造的简历会留下、且可能已设主），
        故这三例各自重新 require 一份全新 ResumeLibrary（独立内存后端 + 空索引）做隔离。 */
  {
    name: '主简历：setMaster 互斥，库里唯一',
    fn: (ctx) => {
      delete require.cache[require.resolve('../js/store/resume-library.js')];
      const L = require('../js/store/resume-library.js').ResumeLibrary;
      let a = null, b = null;
      return L.create({ title: 'A', payload: { data: { name: 'a' } } })
        .then((m) => { a = m.id; return L.create({ title: 'B', payload: { data: { name: 'b' } } }); })
        .then((m) => {
          b = m.id;
          return L.setMaster(a);
        }).then((set) => {
          ctx.assert(set === true, '首次设为唯一主返回 true');
          ctx.assert(L.getMeta(a).isMaster === true, 'A 标记为主');
          ctx.assert(!L.getMeta(b).isMaster, 'B 非主');
          return L.setMaster(b);
        }).then((set) => {
          ctx.assert(set === true, '改设 B 为主返回 true');
          ctx.assert(L.getMeta(b).isMaster === true, 'B 标记为主');
          ctx.assert(!L.getMeta(a).isMaster, '⚠️ 互斥：A 被取消');
          return L.setMaster(b);
        }).then((set) => {
          ctx.assert(set === false, '对已为主者再 setMaster → 取消，返回 false');
          ctx.assert(!L.getMeta(b).isMaster, '取消后 B 非主');
          ctx.assert(!L.getMeta(a).isMaster, '取消后 A 仍非主（库里暂时无主）');
          return L.list();
        }).then((idx) => {
          ctx.assert(idx.every((m) => !m.isMaster), '取消后列表里无主');
        });
    }
  },
  {
    name: '主简历：list 把主简历排在第一',
    fn: (ctx) => {
      delete require.cache[require.resolve('../js/store/resume-library.js')];
      const L = require('../js/store/resume-library.js').ResumeLibrary;
      let a = null, b = null, c = null;
      return L.create({ title: 'A', payload: { data: { name: 'a' } } })
        .then((m) => { a = m.id; return L.create({ title: 'B', payload: { data: { name: 'b' } } }); })
        .then((m) => { b = m.id; return L.create({ title: 'C', payload: { data: { name: 'c' } } }); })
        .then((m) => { c = m.id; return L.setMaster(c); })
        .then(() => L.list())
        .then((idx) => {
          ctx.assert(idx.length === 3, '全新实例共 3 份');
          ctx.assert(idx[0].id === c, '主简历 C 排第一');
          ctx.assert(idx.findIndex((m) => m.id === c) < idx.findIndex((m) => m.id === a), 'C 在 A 之前');
          ctx.assert(idx.findIndex((m) => m.id === c) < idx.findIndex((m) => m.id === b), 'C 在 B 之前');
        });
    }
  },
  {
    name: '主简历：init 自动播种——无主时把源头简历（有派生子的母简历）标为主',
    fn: (ctx) => {
      delete require.cache[require.resolve('../js/store/resume-library.js')];
      const L = require('../js/store/resume-library.js').ResumeLibrary;
      return L.create({ title: '母', payload: { data: { name: 'm' } } })
        .then((master) => {
          return L.derive({ parentId: master.id, title: '母 · 定制' })
            .then(() => L.init())
            .then((r) => {
              ctx.assert(r.count === 2, '全新实例共 2 份');
              const masterMeta = L.getMeta(master.id);
              ctx.assert(masterMeta.isMaster === true, '有派生子的母简历被自动标为主');
              const kids = L._stores._index().filter((m) => m.parentId === master.id);
              ctx.assert(kids.every((k) => !k.isMaster), '派生子均非主');
              return L.list();
            }).then((idx) => {
              ctx.assert(idx[0].id === master.id, '源头条排在第一');
            });
        });
    }
  },
  {
    name: 'N3：beginRemoveBatch 清空上一批，整批删除可一次全部找回',
    fn: (ctx) => {
      const L = ctx.ResumeLibrary;
      const payload = { data: { name: 'n', contact: [], sections: [] } };
      const made = [];
      /* ⚠️ 不假设库是空的：本文件前面的用例已经留下了简历。
         断言一律用「相对变化」而不是绝对值，否则用例顺序一变就假红。 */
      return L.create({ title: 'N3批A', payload: payload })
        .then((m) => { made.push(m.id); return L.create({ title: 'N3批B', payload: payload }); })
        .then((m) => { made.push(m.id); return L.list().then((idx) => idx.length); })
        .then((before) => {
          ctx.assert(before >= 2, '库里至少有刚造的这 2 份');
          L.beginRemoveBatch();
          return Promise.all(made.map((id) => L.remove(id))).then(() => before);
        })
        .then((before) => L.list().then((idx) => {
          ctx.assert(idx.length === before - 2, '整批删除后总数正好 -2');
          ctx.assert(idx.filter((m) => made.indexOf(m.id) >= 0).length === 0, '这 2 份已不在列表里');
          ctx.assert(L.peekRemoved().length === 2, '撤销栈含整批 2 份');
          return L.undoRemove();
        }))
        .then((restored) => {
          ctx.assert(restored.length === 2, '整批一次全部找回（不必逐份撤）');
          L.beginRemoveBatch();
          ctx.assert(L.peekRemoved().length === 0, '⚠️ 开新批次即清空上一批（撤回不会连带复活更早的删除）');
        });
    }
  }
];
