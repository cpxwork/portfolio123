from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor,white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph
import json, os

ROOT=Path(__file__).resolve().parent;OUT=ROOT/'membership-conversion-ab.pdf'
pdfmetrics.registerFont(TTFont('Song',os.environ.get('SIMSUN_FONT','C:/Windows/Fonts/simsun.ttc'),subfontIndex=0))
pdfmetrics.registerFontFamily('Song',normal='Song',bold='Song',italic='Song',boldItalic='Song')
W,H=A4;M=43;CW=W-2*M
INK=HexColor('#163746');TEXT=HexColor('#243B46');MUTED=HexColor('#596F7B');TEAL=HexColor('#367D76');PALE=HexColor('#EFF5F3');LINE=HexColor('#D4E1E5')
C=canvas.Canvas(str(OUT),pagesize=A4,pageCompression=1)
C.setTitle('陈鹏旭 会员转化与AB实验方案 产品练习');C.setAuthor('陈鹏旭')
C.setSubject('模拟订阅工具的会员权益呈现、PRD、指标与随机实验设计；未运行线上实验')
audit=[]
def txt(s,x,y,size=11,color=TEXT):
 if x+pdfmetrics.stringWidth(s,'Song',size)>W-M+1:raise ValueError('Text overflow: '+s)
 C.setFont('Song',size);C.setFillColor(color);C.drawString(x,H-y-size,s)
def p(s,x,y,w=CW,size=11,leading=17,max_h=None,color=TEXT):
 pp=Paragraph(s,ParagraphStyle('p',fontName='Song',fontSize=size,leading=leading,textColor=color,wordWrap='CJK'))
 _,h=pp.wrap(w,H)
 if max_h and h>max_h+.01:raise ValueError(f'Tall p{C.getPageNumber()}: {h}>{max_h} {s[:40]}')
 if y+h>H-57:raise ValueError('Below page: '+s[:40])
 pp.drawOn(C,x,H-y-h);audit.append([C.getPageNumber(),x,y,w,h,s[:80]])
 return y+h
def line(x,y,x2,y2,color=LINE):
 C.setStrokeColor(color);C.setLineWidth(.7);C.line(x,H-y,x2,H-y2)
def box(x,y,w,h,color=PALE):
 C.setFillColor(color);C.roundRect(x,H-y-h,w,h,5,fill=1,stroke=0)
def heading(s,y):txt(s,M,y,13,INK)
def footer(n):
 line(M,796,W-M,796);txt('陈鹏旭  |  产品设计与实验方案练习  |  2026.10',M,808,8,MUTED);txt(str(n)+' / 2',W-M-28,808,8,MUTED);C.showPage()
def table(headers,rows,y,widths,size=10.7):
 box(M,y,CW,28,INK);x=M
 for a,w in zip(headers,widths):txt(a,x+10,y+7,10,white);x+=w
 y+=28
 for j,row in enumerate(rows):
  hs=[]
  for a,w in zip(row,widths):
   pp=Paragraph(a,ParagraphStyle('a',fontName='Song',fontSize=size,leading=15,wordWrap='CJK'));hs.append(pp.wrap(w-20,H)[1])
  rh=max(hs)+18
  if j%2==0:box(M,y,CW,rh,HexColor('#F5F7F8'))
  x=M
  for a,w in zip(row,widths):p(a,x+10,y+8,w-20,size,15,max_h=rh-16);x+=w
  line(M,y+rh,W-M,y+rh);y+=rh
 return y

C.bookmarkPage('p1');C.addOutlineEntry('问题假设与产品方案','p1',0)
txt('会员权益呈现与转化验证方案',M,37,21,INK)
txt('模拟文件整理订阅工具  |  PRD 与 A/B 设计  |  陈鹏旭',M,72,10.5,MUTED)
p('性质：新增 AI 辅助产品练习，非百度内部项目。当前交付为静态方案、埋点与实验定义；没有真实用户、流量、线上实验或收益结果。',M,102,size=10.5,leading=16,max_h=48)
heading('一、待验证的问题与最小方案',166)
p('假设：免费用户点击升级后，可能因权益差异和续费规则不清而退出。方案只检验权益信息的组织方式，不调整价格、实际权益或支付能力；此假设尚无用户研究证据。',M,193,max_h=68)
gap=18;ww=(CW-gap)/2
for i,(title,body) in enumerate([
 ('A：基础呈现','权益逐项列出<br/>总价、期限、续费规则明确展示<br/>保留现有信息层级与顺序<br/><br/>相同的“确认方案”按钮'),
 ('B：对照呈现','免费 / 会员权益并排对照<br/>总价、期限、续费规则同样展示<br/>突出差异，调整组织与排序<br/><br/>相同的“确认方案”按钮')]):
 x=M+i*(ww+gap);box(x,279,ww,137);txt(title,x+13,292,12,INK);p(body,x+13,320,ww-26,10.2,15,max_h=90)
txt('原型示意：静态产品方案，不接入真实支付。',M,427,9.5,MUTED)
heading('二、主流程与异常验收',463)
flow=['点击升级','方案页','确认订单','支付','权益到账'];gap=13;ww=(CW-4*gap)/5
for i,s in enumerate(flow):
 x=M+i*(ww+gap);box(x,492,ww,38);txt(s,x+8,504,10.3,INK)
 if i<4:
  line(x+ww+2,511,x+ww+gap-2,511,TEAL)
p('取消支付可返回；失败可重试；自动续费须单独明确确认，禁止默认勾选。重复支付回调须幂等；已扣款但权益未到账时显示“处理中”，提供查询与客服入口。验收覆盖断网、延迟回调和重复请求。',M,551,max_h=85)
heading('三、最少埋点与数据约束',654)
p('事件：eligible_assign、page_exposure、plan_select、checkout_create、pay_success、benefit_grant、refund_success。携带去标识账号键、实验版本、会话与订单 ID、事件时间和接收时间；先去重，再排查乱序、延迟与客户端漏报。',M,681,size=10.4,leading=16,max_h=80)
footer(1)

C.bookmarkPage('p2');C.addOutlineEntry('分流指标与决策规则','p2',0)
txt('分流、指标与实验决策',M,37,21,INK)
txt('先锁定口径，再采集数据；此页为设计方案，尚未执行线上实验。',M,74,10.3,MUTED)
heading('四、用户级随机分流与固定观察窗',113)
p('对象：首次触发升级入口、尚未订阅的登录用户。在任何实验内容展示前，以账号稳定随机 50/50 分组；重复访问不换组，跨设备共用账号分组。匿名、跨账号和身份无法合并的行为另记限制。曝光失败仍保留在分母，避免只挑已看到页面的人。',M,140,size=10.6,leading=16,max_h=80)
y=table(['指标','预先固定的定义'],[
 ('唯一主指标：<br/>7 日支付转化率','分母为全部已分组的合格用户（ITT）；分子为分组后 7×24 小时内至少一笔服务端确认成功会员支付的用户，按账号去重。只计算 7 日观察窗已成熟的批次。'),
 ('退款护栏：<br/>第 14 日快照','按用户分组后第 14 日取快照；分母为前 7 日成功支付用户，分子为其中截至快照发生退款的用户。更晚退款不在本次快照内；最终决策等待该护栏成熟。'),
 ('其他护栏','支付错误、权益到账失败、投诉分别定义分母、观察窗与容忍阈值。阈值需用真实基线在上线前锁定，当前不虚构数值。其余行为指标用于诊断。')],243,[126,CW-126],10.3)
heading('五、严格漏斗与主指标分开计算',y+20)
p('诊断漏斗：同一账号及对应会话 / 订单，按事件时间依次满足“曝光、选方案、建单、支付”，限定分组后 7 日并记录掉点原因。“分别出现过各事件”的覆盖率查询不作为严格漏斗；也不直接用它替代 ITT 或证明实验因果。',M,y+46,size=10.5,leading=16,max_h=80)
heading('六、样本、统计与停止规则',y+126)
p('上线前依据真实历史基线、最小可接受差异与功效估算样本，预先锁定样本量和周期，覆盖完整周并考虑新奇效应；未取得基线前不填写虚构样本量。样本不足按预设上限延长，或报告不确定。',M,y+152,size=10.5,leading=16,max_h=64)
p('预注册一次双侧两比例主检验，稀疏数据用预设精确检验；报告比例差及 95% 置信区间。不根据每日显著性提前结束。期间仅监控数据质量和护栏；只有预设护栏越界、分流异常或严重故障触发停机。方案修改后另开实验；达到样本量且相关窗口成熟后统一判定。',M,y+226,size=10.5,leading=16,max_h=96)
footer(2)
C.save()
(ROOT/'layout-audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf-8')
print(OUT)
