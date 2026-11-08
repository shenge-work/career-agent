import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, fmtTime, type ApplicationItem, type CompanyItem, type ResumeItem } from '../api';

const STATUS_LABEL: Record<ApplicationItem['status'], string> = {
  interested: '有意向',
  applied: '已投递',
  interviewing: '面试中',
  offered: '已录用',
  rejected: '已拒绝',
  withdrawn: '已撤回',
};

const STATUS_ORDER: ApplicationItem['status'][] = [
  'interested',
  'applied',
  'interviewing',
  'offered',
  'rejected',
  'withdrawn',
];

/** 首页 · 求职仪表盘：一屏回答「投了多少 / 卡在哪 / 下一步」。 */
export default function Home() {
  const { data: apps = [], isLoading } = useQuery({
    queryKey: ['applications'],
    queryFn: () => api<ApplicationItem[]>('/applications'),
  });
  const { data: resumes = [] } = useQuery({
    queryKey: ['resumes'],
    queryFn: () => api<ResumeItem[]>('/resumes'),
  });
  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<CompanyItem[]>('/companies'),
  });

  const master = resumes.find((r) => r.isMaster);
  const active = apps.filter((a) => !['rejected', 'withdrawn'].includes(a.status));
  const interviewing = apps.filter((a) => a.status === 'interviewing');
  const offered = apps.filter((a) => a.status === 'offered');
  const awaiting = apps.filter((a) => a.status === 'applied');

  // 该跟进了：已投递 + 设了跟进天数 + appliedAt 已过 followUpAfterDays 天
  const now = Date.now();
  const dueForFollowUp = apps.filter((a) => {
    if (a.status !== 'applied' || a.followUpAfterDays == null || !a.appliedAt) return false;
    const applied = new Date(a.appliedAt).getTime();
    if (!Number.isFinite(applied)) return false;
    return now - applied >= a.followUpAfterDays * 24 * 60 * 60 * 1000;
  });

  // 各状态计数，供漏斗展示
  const counts = STATUS_ORDER.map((s) => ({
    status: s,
    label: STATUS_LABEL[s],
    n: apps.filter((a) => a.status === s).length,
  }));

  const recent = [...apps]
    .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
    .slice(0, 5);

  return (
    <div className="dashboard">
      <div className="dash-head">
        <h1 className="dash-title">求职总览</h1>
        <p className="dash-sub">一屏看清你的求职进展，决定下一步推进什么。</p>
      </div>

      {isLoading ? (
        <p className="muted">加载中…</p>
      ) : (
        <>
          {/* 关键指标卡片 */}
          <div className="dash-stats">
            <StatCard label="总投递" value={apps.length} hint="全部岗位" tone="blue" />
            <StatCard label="进行中" value={active.length} hint="未结束的机会" tone="blue" />
            <StatCard label="面试中" value={interviewing.length} hint="需要准备" tone="amber" />
            <StatCard label="已录用" value={offered.length} hint="拿到 Offer" tone="green" />
            <StatCard label="已拒绝" value={apps.filter(a => a.status === 'rejected').length} hint="未通过" tone="red" />
          </div>

          {/* 该跟进了 */}
          {dueForFollowUp.length > 0 && (
            <section className="dash-card follow-up-card">
              <div className="dash-card-title">该跟进了（{dueForFollowUp.length}）</div>
              <ul className="dash-list">
                {dueForFollowUp.map((a) => (
                  <li key={a.id}>
                    <Link to="/applications" className="dash-link">
                      <span className="dash-link-main">{a.position}</span>
                      <span className="chip">
                        {a.appliedAt ? fmtTime(a.appliedAt) : ''}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 投递漏斗 */}
          <section className="dash-card">
            <div className="dash-card-title">投递漏斗</div>
            <div className="funnel">
              {counts.map((c) => (
                <div key={c.status} className="funnel-row">
                  <span className="funnel-label">{c.label}</span>
                  <div className="funnel-bar">
                    <div
                      className="funnel-fill"
                      style={{ width: `${apps.length ? (c.n / apps.length) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="funnel-count">{c.n}</span>
                </div>
              ))}
            </div>
          </section>

          <div className="dash-cols">
            {/* 最近岗位 */}
            <section className="dash-card">
              <div className="dash-card-title">
                最近岗位
                <Link to="/applications" className="dash-card-more">查看全部 →</Link>
              </div>
              {recent.length ? (
                <ul className="dash-list">
                  {recent.map((a) => {
                    const company = companies.find((c) => c.id === a.companyId);
                    const salary = (a.payload?.salary as string) || '';
                    return (
                      <li key={a.id}>
                        <Link to="/applications" className="dash-link">
                          <span className="dash-link-main">{a.position}</span>
                          <span className={`chip status-${a.status}`}>{STATUS_LABEL[a.status]}</span>
                        </Link>
                        <div className="muted small dash-meta">
                          {company && <span className="dash-company">{company.name}</span>}
                          {salary && <span className="dash-salary">{salary}</span>}
                          <span className="dash-time">{fmtTime(a.updatedAt)}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted small">
                  还没有岗位。去 <Link to="/applications">岗位</Link> 新建第一个。
                </p>
              )}
            </section>

            {/* 下一步建议 */}
            <section className="dash-card">
              <div className="dash-card-title">下一步建议</div>
              <ul className="dash-next">
                {!master && (
                  <li>
                    <Link to="/resumes">设置主简历</Link>，作为所有岗位定制的基础。
                  </li>
                )}
                {awaiting.length > 0 && (
                  <li>
                    有 <b>{awaiting.length}</b> 个岗位已投递、等待回复，记得按设定时间跟进。
                  </li>
                )}
                {dueForFollowUp.length > 0 && (
                  <li>
                    <b>{dueForFollowUp.length}</b> 个岗位已到跟进时间，去 <Link to="/applications">岗位</Link> 推进或更新状态。
                  </li>
                )}
                {interviewing.length > 0 && (
                  <li>
                    有 <b>{interviewing.length}</b> 个岗位进入面试，去准备逐字稿与复盘。
                  </li>
                )}
                {apps.length === 0 && (
                  <li>从一个岗位开始：粘贴 JD、定制简历、投递、跟进，闭环推进。</li>
                )}
                {master && apps.length > 0 && active.length === apps.length && awaiting.length === 0 && interviewing.length === 0 && (
                  <li>暂无等待回复或面试中的岗位，去新增或推进目标岗位。</li>
                )}
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone: 'blue' | 'amber' | 'green' | 'gray' | 'red';
}) {
  return (
    <div className={`stat-card ${tone}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-hint">{hint}</div>
    </div>
  );
}
