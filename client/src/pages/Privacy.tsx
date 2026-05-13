import { Link } from 'react-router-dom'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'

export default function Privacy() {
  return (
    <div className="min-h-screen pt-20 px-4 pb-20" style={{ background: 'var(--bg-primary)' }}>
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
            <li><strong>临时节点元数据</strong>：节点编号、通行码 hash、最近活跃时间（30min 后自动清除）</li>
            <li><strong>聚合统计</strong>：在线节点数、传输次数、总流量（不关联具体用户）</li>
            <li><strong>错误日志</strong>：异常堆栈（不含用户输入或敏感数据）</li>
          </ul>

          <h2 className="font-bold mt-4">我们不收集什么</h2>
          <ul className="text-[var(--text-on-white-2)] list-disc pl-5 space-y-1">
            <li>真实身份信息（姓名、邮箱、电话）</li>
            <li>文件内容或文件元数据（文件名、大小、路径）</li>
            <li>IP 地址（无持久日志，重启即清）</li>
            <li>Cookie 或持久标识符</li>
            <li>浏览行为日志</li>
          </ul>

          <h2 className="font-bold mt-4">数据存储</h2>
          <p className="text-[var(--text-on-white-2)]">
            所有服务器数据仅存在于内存中。无数据库持久化。信令服务器重启后所有临时数据清空。
          </p>

          <h2 className="font-bold mt-4">数据共享</h2>
          <p className="text-[var(--text-on-white-2)]">
            本服务不与任何第三方共享任何用户数据。我们不出售数据，也没有可出售的数据。
          </p>

          <h2 className="font-bold mt-4">端到端加密</h2>
          <p className="text-[var(--text-on-white-2)]">
            P2P 文件传输使用 DTLS（WebRTC 内置）+ AES-GCM-256 应用层加密。
            即使启用 TURN 中继，服务器也无法解密传输内容。
          </p>

          <h2 className="font-bold mt-4">客户端本地存储</h2>
          <p className="text-[var(--text-on-white-2)]">
            以下数据存储在用户浏览器本地：身份信息（sessionStorage）、TURN 服务器配置（localStorage）、
            黑名单（localStorage）、传输进度（IndexedDB）。这些数据不上传服务器。
          </p>

          <h2 className="font-bold mt-4">用户权利</h2>
          <p className="text-[var(--text-on-white-2)]">
            用户可随时清除浏览器本地存储以删除所有本地数据。
            服务端数据在 30 分钟无活动后自动过期，或手动调用释放接口立即清除。
          </p>

          <p className="text-[var(--text-on-white-2)] mt-6">最后更新：2026-05-13</p>
        </div>

        <Link to="/" className="inline-block mt-6">
          <button className="nav-pill">← 返回首页</button>
        </Link>
      </div>
    </div>
  )
}
