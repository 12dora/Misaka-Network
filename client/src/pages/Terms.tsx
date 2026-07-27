import { Link } from 'react-router-dom'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'

export default function Terms() {
  return (
    <div className="px-4" style={{ background: 'var(--bg-primary)', minHeight: '100dvh', paddingTop: 'calc(var(--nav-h-total) + 1rem)', paddingBottom: 'calc(5rem + var(--safe-bottom))' }}>
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <MisakaKanjiBlock char="条" size="md" />
          <h1 className="font-kanji font-bold text-xl text-white">服务条款</h1>
        </div>

        <div
          className="rounded-2xl p-6 space-y-4 font-kanji text-sm leading-relaxed"
          style={{ background: 'var(--surface)', color: 'var(--text-on-white)' }}
        >
          <p>
            御坂网络（Misaka Network，以下简称「本服务」）是非商业 P2P 文件传输应用，
            定位为《某科学的超电磁炮》同人技术实验项目。
          </p>

          <h2 className="font-bold mt-6">1. 服务性质</h2>
          <p className="text-[var(--text-on-white-2)]">
            本服务不提供可用性保证（SLA），可能随时暂停或终止。信令服务器协调身份、节点发现和 WebRTC 信令；
            文件优先由浏览器直接传输。直连失败且 TURN 已启用时，加密文件流量可能经过服务器自动下发的
            Cloudflare 中继或用户手工配置的中继。
          </p>

          <h2 className="font-bold mt-4">2. 用户责任</h2>
          <p className="text-[var(--text-on-white-2)]">
            用户对通过本服务传输的内容负完全责任。不得使用本服务传播违法、
            侵权、恶意内容。用户有责任保护自己的通行码不被泄露。
          </p>

          <h2 className="font-bold mt-4">3. 数据保留</h2>
          <p className="text-[var(--text-on-white-2)]">
            会话令牌的绝对有效期为 30 分钟；节点、邀请等运行状态按服务端生命周期清理。
            TURN 额度/撤销状态和暴力破解锁会持久化，生产代理也可能保留包含 IP 的访问日志和备份。
            服务器不存储文件内容。具体范围与第三方中继说明见隐私政策。
          </p>

          <h2 className="font-bold mt-4">4. 通行码安全</h2>
          <p className="text-[var(--text-on-white-2)]">
            通行码是节点接入的唯一凭证，连续 3 次错误锁定 5 分钟。
            通行码丢失无法找回，需重新生成身份。
          </p>

          <h2 className="font-bold mt-4">5. 禁止用途</h2>
          <p className="text-[var(--text-on-white-2)]">
            不得使用本服务进行违法活动、传播恶意软件、骚扰他人、或破坏网络运行。
          </p>

          <h2 className="font-bold mt-4">6. 责任限制</h2>
          <p className="text-[var(--text-on-white-2)]">
            本项目开发者不对因使用本服务而产生的任何直接或间接损失承担责任。
          </p>

          <h2 className="font-bold mt-4">7. 版权声明</h2>
          <p className="text-[var(--text-on-white-2)]">
            「御坂网络」概念源自《某科学的超电磁炮》（镰池和马 / 冬川基），
            本服务为独立开发的非营利同人项目，不构成对原作权利的声明。
          </p>

          <p className="text-[var(--text-on-white-2)] mt-6">最后更新：2026-07-27</p>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          {/* A11Y-006: a <button> inside a <Link> nests two interactive
              controls — two tab stops for one action, and browsers disagree
              on which one Enter activates. Style the Link as the pill. */}
          <Link to="/" className="nav-pill">← 返回首页</Link>
          <Link to="/privacy" className="nav-pill">查看隐私政策</Link>
        </div>
      </div>
    </div>
  )
}
