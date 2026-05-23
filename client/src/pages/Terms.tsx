import { Link } from 'react-router-dom'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'

export default function Terms() {
  return (
    <div className="min-h-screen pt-20 px-4 pb-20" style={{ background: 'var(--bg-primary)' }}>
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
            本服务不提供可用性保证（SLA），可能随时暂停或终止。信令服务器仅转发 WebRTC 信令消息，
            文件本体不经服务器传输（除非用户自配置 TURN 中继）。
          </p>

          <h2 className="font-bold mt-4">2. 用户责任</h2>
          <p className="text-[var(--text-on-white-2)]">
            用户对通过本服务传输的内容负完全责任。不得使用本服务传播违法、
            侵权、恶意内容。用户有责任保护自己的通行码不被泄露。
          </p>

          <h2 className="font-bold mt-4">3. 数据保留</h2>
          <p className="text-[var(--text-on-white-2)]">
            服务端仅短期保留匿名节点元数据（30min 无活动自动清除）。
            不记录传输内容、文件名、IP 日志。
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

          <p className="text-[var(--text-on-white-2)] mt-6">最后更新：2026-05-13</p>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Link to="/" className="inline-block">
            <button className="nav-pill">← 返回首页</button>
          </Link>
          <Link to="/privacy" className="inline-block">
            <button className="nav-pill">查看隐私政策</button>
          </Link>
        </div>
      </div>
    </div>
  )
}
