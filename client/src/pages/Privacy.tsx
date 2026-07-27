import { Link } from 'react-router-dom'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'

export default function Privacy() {
  return (
    <div className="px-4" style={{ background: 'var(--bg-primary)', minHeight: '100dvh', paddingTop: 'calc(var(--nav-h-total) + 1rem)', paddingBottom: 'calc(5rem + var(--safe-bottom))' }}>
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <MisakaKanjiBlock char="秘" size="md" />
          <h1 className="font-kanji font-bold text-xl text-white">隐私政策</h1>
        </div>

        <div
          className="rounded-2xl p-6 space-y-4 font-kanji text-sm leading-relaxed"
          style={{ background: 'var(--surface)', color: 'var(--text-on-white)' }}
        >
          <p>
            本隐私政策说明御坂网络（Misaka Network）如何收集、使用、保护用户数据。
          </p>

          <h2 className="font-bold mt-6">我们收集什么</h2>
          <ul className="text-[var(--text-on-white-2)] list-disc pl-5 space-y-1">
            <li><strong>会话与节点元数据</strong>：节点编号、通行码的逐会话加盐 scrypt 验证值、使用部署密钥生成的 HMAC-SHA-256 身份表示、会话令牌、连接状态、IP 地址和最近活动时间</li>
            <li><strong>聚合统计</strong>：在线节点数、传输次数、总流量（不关联具体用户）</li>
            <li><strong>安全与中继状态</strong>：按 IP 的限流、暴力破解锁、TURN 签发与用量记录，以及待重试的撤销任务</li>
            <li><strong>运行日志</strong>：服务错误；生产反向代理启用时也可能记录访问时间、请求路径、状态码和来源 IP</li>
          </ul>

          <h2 className="font-bold mt-4">我们不收集什么</h2>
          <ul className="text-[var(--text-on-white-2)] list-disc pl-5 space-y-1">
            <li>真实身份信息（姓名、邮箱、电话）</li>
            <li>文件内容；文件名和路径由浏览器在对端之间传递，不交给信令 API</li>
            <li>Cookie 或持久标识符</li>
            <li>浏览行为日志</li>
          </ul>

          <h2 className="font-bold mt-4">数据存储</h2>
          <p className="text-[var(--text-on-white-2)]">
            会话、节点、邀请和举报主要保存在服务进程内存中；会话令牌有 30 分钟绝对有效期，
            断开的节点会按服务器清理策略移除。TURN 月度计数、活动凭据、撤销队列以及暴力破解锁会持久化到服务器磁盘，
            以便重启后继续执行额度与安全限制。部署方可能按自己的备份和日志保留策略保存这些数据。
          </p>
          <p className="text-[var(--text-on-white-2)]">
            HMAC 身份表示用于判断同一节点身份并把多台设备路由到同一集群；它在同一部署内具有确定性，
            因此可关联同一通行码的会话，但没有服务器部署密钥时不能直接用公开的六位数字 SHA-256 表反查。
            scrypt 验证值才用于验证通行码，二者用途不同。
          </p>

          <h2 className="font-bold mt-4">数据共享</h2>
          <p className="text-[var(--text-on-white-2)]">
            本项目不出售用户数据。启用服务器自动 TURN 时，会使用 Cloudflare Realtime TURN：
            Cloudflare 会处理短时效凭据、派生标识和中继用量；实际经过 TURN 的加密流量也会穿过其网络。
            手工配置的 TURN 服务由用户选择，其运营方同样可观察连接元数据与加密流量。
          </p>

          <h2 className="font-bold mt-4">端到端加密</h2>
          <p className="text-[var(--text-on-white-2)]">
            P2P 文件传输使用 DTLS（WebRTC 内置）+ AES-GCM-256 应用层加密。
            即使启用 TURN 中继，中继运营方也无法解开应用层 AES-GCM 文件内容；但它仍能观察连接时间、
            来源/目标网络地址和流量大小等网络元数据。
          </p>

          <h2 className="font-bold mt-4">客户端本地存储</h2>
          <p className="text-[var(--text-on-white-2)]">
            以下数据存储在用户浏览器本地：身份与会话（sessionStorage）、手工 TURN 配置（localStorage）、
            传输进度和临时文件块（IndexedDB/浏览器文件系统）。连接服务时，身份和会话所需字段会发送给信令服务器；
            手工 TURN 配置不会发送给信令 API，但浏览器会直接连接该 TURN 服务。
            对于 OPFS 接收文件，点击下载后本站无法观察浏览器何时保存完成，因此不会用固定计时器删除；
            用户确认“已保存并释放临时副本”后才会删除，未确认的副本会保留到用户清除站点数据。
          </p>

          <h2 className="font-bold mt-4">用户权利</h2>
          <p className="text-[var(--text-on-white-2)]">
            用户可清除站点数据来删除浏览器内的身份、配置和传输记录。断开连接会结束当前网络会话；
            服务端令牌到期后不可继续使用。持久安全记录、反向代理日志和备份由部署方按其运维保留策略清理，
            不承诺与会话同时删除。
          </p>

          <p className="text-[var(--text-on-white-2)] mt-6">最后更新：2026-07-27</p>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          {/* A11Y-006: a <button> inside a <Link> nests two interactive
              controls — two tab stops for one action, and browsers disagree
              on which one Enter activates. Style the Link as the pill. */}
          <Link to="/" className="nav-pill">← 返回首页</Link>
          <Link to="/tos" className="nav-pill">查看服务条款</Link>
        </div>
      </div>
    </div>
  )
}
