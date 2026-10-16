# 四个机器人与界面素材

四个角色均用内置 imagegen 生成原创二维插画，未下载素材库角色。每张是透明背景的两帧图：左边温和微笑，右边认真督促。CSS 使用等分 sprite，不依赖外部图片地址。

最终项目文件：`web/pipi.webp`（皮皮）、`web/dida.webp`（滴答）、`web/bobo.webp`（啵啵）、`web/huihui.webp`（回回）。原始 PNG 在生成后转为1400像素宽、保留透明度的WebP供网页使用。该步骤只有尺寸与格式优化，没有用代码重画角色。

## 生成规格与提示词

工具模式：内置 `image_gen`，四次生成、一次皮皮编辑，透明背景开启。

共同生成规格：two-frame transparent 2D robot sprite sheet; original clumsy, lovable robot, neither human nor pet; left gentle smile, right determined eyebrows and a tiny puff; same character scale and accessories; complete figures centered within two equal square cells, generous transparent margins; dark warm wobbly outlines, flat pastel fills, light paper texture only on the robot, stubby limbs; no text, 3D rendering, scenery, watermark or clipping.

- 皮皮：mint and cream bean-shaped robot, dark chocolate face panel, coral idea pouch with pencil, short spring tail; inspiration recorder。初稿有毛绒天线耳朵，用户要求删除，最终以以下编辑提示词替换。
- 滴答：butter-yellow squarish clock robot, small clock on head, compact mechanical hands, timetable accessories; learning scheduler。
- 啵啵：lavender saucer-helmet robot with little paper rocket, playful inventor silhouette, orange details; creative explorer。
- 回回：peach radio/camera robot, broad rounded face panel, notebook and pencil, small curled tail; action-feedback companion。

皮皮最终编辑提示词（完整）：

> Edit this two-frame transparent robot sprite sheet. Make exactly one design change in BOTH frames: completely remove the two fluffy sheep-like antenna ears, their stems, and any attachment at the top/sides of the head. Give Pipi a smooth, round, bald robot head with the same little mint patch on top. No animal ears, no antenna, no replacement protrusions. Preserve the adorable cream-and-mint chunky robot, dark chocolate face panel, coral bag with pencil, little spring tail, stubby limbs, thick warm hand-drawn outlines, gentle smiling expression in LEFT frame, focused determined expression in RIGHT frame, original pose in each frame. Keep exact same two equal square-cell layout and subject scale, same transparent margins, both complete bodies visible, no clipping, no text, no scenery, true transparent background. The smooth bald silhouette should be simple and lovable.

## 界面方向

暖纸色背景、墨色文字、轻线条、薄荷/奶黄/紫/桃色对话气泡。四个角色共同在场，用交接线呈现流程；原文、解释和当前实际安排分开。减少首页表单，保留按需展开的细节。尊重系统减少动态效果设置；虫虫不阻挡页面操作，也不进入桌面。

浏览参考：[Open Peeps](https://www.openpeeps.com/)、[Open Doodles](https://www.opendoodles.com/)、[Humaaans](https://www.humaaans.com/)。这些仅用于查看手绘与组合式插画方法，不是本项目资产来源，不把其素材许可套用给生成图片。
