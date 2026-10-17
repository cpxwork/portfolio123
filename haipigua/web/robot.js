(function () {
  'use strict';

  var instances = new WeakMap();
  var sequence = 0;
  var descriptions = {
    happy: '开心地陪着你',
    excited: '眼睛弯弯，兴奋地举起双手',
    thinking: '歪着脑袋，认真思考',
    proud: '给你竖起大拇指',
    angry: '有一点闹别扭，等你解释原因',
    sorry: '害羞地低下头，表示理解和歉意',
    no: '双手比叉，温柔地提醒你换一个做法',
    sleepy: '闭上眼睛，准备陪你休息'
  };

  function faceMarkup() {
    return '\
      <g class="bot-face bot-face-happy"><g class="bot-eyes-idle">\
        <ellipse cx="145" cy="120" rx="17" ry="20" class="bot-eye-lens"/>\
        <ellipse cx="215" cy="120" rx="17" ry="20" class="bot-eye-lens"/>\
        <g class="bot-pupils"><ellipse cx="146" cy="121" rx="8.5" ry="11" fill="#253436"/><ellipse cx="216" cy="121" rx="8.5" ry="11" fill="#253436"/><circle cx="149" cy="116" r="3" fill="#fff"/><circle cx="219" cy="116" r="3" fill="#fff"/></g></g>\
        <path d="M170 145 Q180 154 190 145" class="bot-mouth"/>\
      </g>\
      <g class="bot-face bot-face-excited">\
        <path d="M130 123 Q145 103 160 123 M200 123 Q215 103 230 123" class="bot-eye-line"/>\
        <path d="M169 139 Q180 136 191 139 Q189 158 180 158 Q171 157 169 139" fill="#fff3d7"/>\
        <path d="M174 153 Q180 148 186 153 L183 158 L178 158 Z" fill="#efa399"/>\
      </g>\
      <g class="bot-face bot-face-thinking">\
        <ellipse cx="145" cy="120" rx="17" ry="20" class="bot-eye-lens"/><ellipse cx="215" cy="120" rx="17" ry="20" class="bot-eye-lens"/>\
        <ellipse cx="153" cy="118" rx="7.5" ry="10" fill="#253436"/><ellipse cx="222" cy="118" rx="7.5" ry="10" fill="#253436"/>\
        <circle cx="155" cy="114" r="2.5" fill="#fff"/><circle cx="224" cy="114" r="2.5" fill="#fff"/>\
        <path d="M130 96 Q144 89 157 95" fill="none" stroke="#e9c48f" stroke-width="3.5" stroke-linecap="round"/>\
        <path d="M175 146 L185 144" class="bot-mouth"/>\
      </g>\
      <g class="bot-face bot-face-proud">\
        <path d="M129 123 Q145 108 161 123 M199 123 Q215 108 231 123" class="bot-eye-line"/>\
        <path d="M169 141 Q180 155 191 141" class="bot-mouth"/>\
      </g>\
      <g class="bot-face bot-face-angry">\
        <path d="M129 110 L162 119 Q161 140 145 140 Q128 136 129 110" fill="#fff3d7"/>\
        <path d="M198 119 L231 110 Q232 136 215 140 Q199 140 198 119" fill="#fff3d7"/>\
        <ellipse cx="148" cy="127" rx="7" ry="9" fill="#253436"/><ellipse cx="212" cy="127" rx="7" ry="9" fill="#253436"/>\
        <path d="M128 107 L163 116 M197 116 L232 107" fill="none" stroke="#efb27f" stroke-width="5" stroke-linecap="round"/>\
        <path d="M172 149 Q176 144 180 148 Q184 144 188 149" class="bot-mouth"/>\
      </g>\
      <g class="bot-face bot-face-sorry">\
        <ellipse cx="145" cy="122" rx="16" ry="19" class="bot-eye-lens"/><ellipse cx="215" cy="122" rx="16" ry="19" class="bot-eye-lens"/>\
        <ellipse cx="149" cy="130" rx="7.5" ry="9" fill="#253436"/><ellipse cx="211" cy="130" rx="7.5" ry="9" fill="#253436"/>\
        <circle cx="151" cy="126" r="2.4" fill="#fff"/><circle cx="213" cy="126" r="2.4" fill="#fff"/>\
        <path d="M130 97 Q142 103 157 98 M203 98 Q217 103 231 97" fill="none" stroke="#e9c48f" stroke-width="3" stroke-linecap="round"/>\
        <path d="M174 150 Q180 145 186 150" class="bot-mouth"/>\
      </g>\
      <g class="bot-face bot-face-no">\
        <ellipse cx="145" cy="121" rx="17" ry="20" class="bot-eye-lens"/><ellipse cx="215" cy="121" rx="17" ry="20" class="bot-eye-lens"/>\
        <ellipse cx="145" cy="123" rx="8" ry="10" fill="#253436"/><ellipse cx="215" cy="123" rx="8" ry="10" fill="#253436"/>\
        <circle cx="148" cy="118" r="3" fill="#fff"/><circle cx="218" cy="118" r="3" fill="#fff"/>\
        <ellipse cx="180" cy="146" rx="5" ry="6" fill="#fff3d7"/>\
      </g>\
      <g class="bot-face bot-face-sleepy">\
        <path d="M130 122 Q145 130 160 122 M200 122 Q215 130 230 122" class="bot-eye-line"/>\
        <path d="M178 144 Q181 140 184 144 Q185 151 181 151 Q177 149 178 144" fill="#fff3d7"/>\
      </g>';
  }

  function frontMarkup(id) {
    return '\
      <svg class="bot-svg" viewBox="0 0 360 340" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="' + id + '-title">\
        <title id="' + id + '-title">皮皮：开心地陪着你</title>\
        <defs>\
          <linearGradient id="' + id + '-shell" x1="112" y1="62" x2="249" y2="279" gradientUnits="userSpaceOnUse"><stop stop-color="#ffffff"/><stop offset=".47" stop-color="#fffdf4"/><stop offset="1" stop-color="#e8e6d7"/></linearGradient>\
          <linearGradient id="' + id + '-body" x1="132" y1="183" x2="232" y2="282" gradientUnits="userSpaceOnUse"><stop stop-color="#fffffa"/><stop offset=".64" stop-color="#f7f5e9"/><stop offset="1" stop-color="#e8e5d8"/></linearGradient>\
          <linearGradient id="' + id + '-screen" x1="136" y1="85" x2="223" y2="159" gradientUnits="userSpaceOnUse"><stop stop-color="#435459"/><stop offset="1" stop-color="#263537"/></linearGradient>\
          <linearGradient id="' + id + '-gold" x1="147" y1="198" x2="207" y2="256" gradientUnits="userSpaceOnUse"><stop stop-color="#ffe6a8"/><stop offset="1" stop-color="#eabe79"/></linearGradient>\
          <linearGradient id="' + id + '-lens" x1="145" y1="99" x2="145" y2="142" gradientUnits="userSpaceOnUse"><stop stop-color="#ffffff"/><stop offset="1" stop-color="#ffedc5"/></linearGradient>\
          <radialGradient id="' + id + '-halo"><stop stop-color="#f9e9c4" stop-opacity=".76"/><stop offset="1" stop-color="#f9e9c4" stop-opacity="0"/></radialGradient>\
          <filter id="' + id + '-shadow" x="-35%" y="-30%" width="175%" height="180%"><feDropShadow dx="0" dy="8" stdDeviation="7" flood-color="#8b7959" flood-opacity=".14"/></filter>\
        </defs>\
        <g class="bot-float">\
          <g class="bot-leg" transform="rotate(-6 145 287)"><rect x="127" y="266" width="33" height="22" rx="12" fill="#d5b681"/><rect x="111" y="281" width="60" height="24" rx="12" fill="url(#' + id + '-shell)" stroke="#dedccd" stroke-width="1.3"/><path d="M119 298 H161" stroke="#d8d5c6" stroke-width="3" stroke-linecap="round"/><path d="M121 286 H134" stroke="#fff" stroke-width="3" stroke-linecap="round"/></g>\
          <g class="bot-leg" transform="rotate(6 215 287)"><rect x="200" y="266" width="33" height="22" rx="12" fill="#d5b681"/><rect x="189" y="281" width="60" height="24" rx="12" fill="url(#' + id + '-shell)" stroke="#dedccd" stroke-width="1.3"/><path d="M199 298 H241" stroke="#d8d5c6" stroke-width="3" stroke-linecap="round"/><path d="M201 286 H214" stroke="#fff" stroke-width="3" stroke-linecap="round"/></g>\
          <g class="bot-arm-anchor-left" transform="translate(113 207)"><g class="bot-arm-left">\
            <circle r="12" fill="#dcb77b" stroke="#f5d39b" stroke-width="3"/><path d="M-5 2 C-18 7 -24 21 -28 36" stroke="#dddccf" stroke-width="20" stroke-linecap="round"/><path d="M-7 1 C-20 10 -23 20 -25 31" stroke="#fffdf4" stroke-width="13" stroke-linecap="round"/>\
            <g transform="translate(-30 41) rotate(16)"><rect x="-13" y="-11" width="27" height="28" rx="12" fill="url(#' + id + '-shell)" stroke="#d9d5c5" stroke-width="1.2"/><path d="M-5 10 V14 M2 11 V15 M8 9 V13" stroke="#cdc8b7" stroke-width="1.5" stroke-linecap="round"/><path d="M-12 -4 Q-18 -5 -16 4 Q-13 9 -10 8" fill="#f9f6e8" stroke="#d9d5c5" stroke-width="1.2"/></g>\
          </g></g>\
          <g class="bot-arm-anchor-right" transform="translate(247 207)"><g class="bot-arm-right">\
            <circle r="12" fill="#dcb77b" stroke="#f5d39b" stroke-width="3"/><path d="M5 2 C18 7 24 21 28 36" stroke="#dddccf" stroke-width="20" stroke-linecap="round"/><path d="M7 1 C20 10 23 20 25 31" stroke="#fffdf4" stroke-width="13" stroke-linecap="round"/>\
            <g transform="translate(30 41) rotate(-16)"><rect x="-14" y="-11" width="27" height="28" rx="12" fill="url(#' + id + '-shell)" stroke="#d9d5c5" stroke-width="1.2"/><path d="M-8 9 V13 M-2 11 V15 M5 10 V14" stroke="#cdc8b7" stroke-width="1.5" stroke-linecap="round"/><path d="M12 -4 Q18 -5 16 4 Q13 9 10 8" fill="#f9f6e8" stroke="#d9d5c5" stroke-width="1.2"/></g>\
          </g></g>\
          <rect x="158" y="166" width="44" height="22" rx="9" fill="#d8b883"/><path d="M163 173 H197 M163 179 H197" stroke="#f5d59e" stroke-width="3" stroke-linecap="round"/>\
          <g class="bot-body">\
            <path d="M136 181 Q180 167 224 181 Q249 193 250 234 Q251 269 226 280 Q180 296 134 280 Q109 269 110 234 Q111 193 136 181Z" fill="url(#' + id + '-body)" stroke="#dedbcc" stroke-width="1.3" filter="url(#' + id + '-shadow)"/>\
            <path d="M126 199 Q128 193 138 190" stroke="#fff" stroke-width="5" stroke-linecap="round"/><path d="M121 230 Q119 254 133 267" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".75"/>\
            <rect x="148" y="205" width="64" height="53" rx="21" fill="url(#' + id + '-gold)" stroke="#e8c895" stroke-width="1.2"/>\
            <path d="M159 211 Q171 205 185 208" stroke="#fff4d6" stroke-width="3" stroke-linecap="round"/>\
            <g class="bot-heart"><path d="M180 240 C174 235 164 229 166 221 C168 214 177 215 180 220 C183 215 192 214 194 221 C196 229 186 235 180 240Z" fill="#d5836e"/><path d="M170 222 Q171 219 175 220" stroke="#f5c0a5" stroke-width="2.5" stroke-linecap="round"/></g>\
            <circle cx="169" cy="271" r="2.5" fill="#9cb6a6"/><circle cx="180" cy="272" r="2.5" fill="#9cb6a6"/><circle cx="191" cy="271" r="2.5" fill="#d3d4bd"/>\
            <path d="M153 281 Q180 286 207 281" stroke="#d7d4c5" stroke-width="1.5" stroke-linecap="round"/>\
          </g>\
          <g class="bot-head">\
            ' + fluffyEarMarkup(111, 57, false) + fluffyEarMarkup(249, 57, false) + '\
            <g class="bot-ear-left"><rect x="67" y="103" width="26" height="43" rx="12" fill="url(#' + id + '-gold)" stroke="#d9ba89" stroke-width="1.3"/><rect x="71" y="114" width="8" height="20" rx="4" fill="#f8dda9"/><path d="M73 115 V132" stroke="#fff3cf" stroke-width="2" stroke-linecap="round"/></g>\
            <g class="bot-ear-right"><rect x="267" y="103" width="26" height="43" rx="12" fill="url(#' + id + '-gold)" stroke="#d9ba89" stroke-width="1.3"/><rect x="281" y="114" width="8" height="20" rx="4" fill="#edcb94"/></g>\
            <path d="M91 77 Q110 58 180 58 Q250 58 269 77 Q283 93 280 126 Q278 158 260 169 Q232 186 180 186 Q128 186 100 169 Q82 158 80 126 Q77 93 91 77Z" fill="url(#' + id + '-shell)" stroke="#dedbcc" stroke-width="1.4" filter="url(#' + id + '-shadow)"/>\
            <path d="M105 75 Q122 65 160 66" stroke="#fff" stroke-width="5" stroke-linecap="round"/><path d="M91 97 Q85 116 89 135" stroke="#fff" stroke-width="3" stroke-linecap="round"/>\
            <rect x="98" y="84" width="164" height="80" rx="31" fill="url(#' + id + '-screen)" stroke="#d3d5c8" stroke-width="2"/>\
            <path d="M113 98 Q119 91 133 91 H212" stroke="#687676" stroke-width="2" stroke-linecap="round" opacity=".65"/>\
            <g class="bot-cheeks"><ellipse cx="120" cy="143" rx="10" ry="5" fill="#edb49d" opacity=".65"/><ellipse cx="240" cy="143" rx="10" ry="5" fill="#edb49d" opacity=".65"/></g>\
            ' + faceMarkup() + '\
            <g class="bot-shell-details"><circle cx="112" cy="170" r="2" fill="#c7c3b2"/><circle cx="248" cy="170" r="2" fill="#c7c3b2"/><path d="M162 174 H198" stroke="#d4d0bd" stroke-width="2" stroke-linecap="round"/></g>\
            <g class="bot-sorry-drop"><path d="M263 89 Q270 98 270 102 A7 7 0 0 1 256 102 Q256 98 263 89Z" fill="#a6cbd1" stroke="#e6f4f4" stroke-width="1.5"/><path d="M261 101 V103" stroke="#fff" stroke-width="2" stroke-linecap="round"/></g>\
            <g class="bot-angry-mark" stroke="#dc9278" stroke-width="3" stroke-linecap="round"><path d="M239 58 L239 64 L245 64 M253 58 L253 64 L247 64 M239 76 L239 70 L245 70 M253 76 L253 70 L247 70"/></g>\
          </g>\
          <g class="bot-proud-arm">\
            <path d="M249 210 Q277 193 278 172" stroke="#d9d8cc" stroke-width="21" stroke-linecap="round"/><path d="M249 207 Q275 190 275 172" stroke="#fffdf3" stroke-width="14" stroke-linecap="round"/>\
            <path d="M268 179 L267 157 Q266 152 270 149 L276 145 L277 132 Q278 123 284 125 Q291 126 289 140 L288 147 L300 147 Q308 147 308 154 L306 174 Q305 181 297 183 L278 185 Q272 185 268 179Z" fill="url(#' + id + '-shell)" stroke="#d7d2c1" stroke-width="1.4"/>\
            <path d="M294 155 H305 M293 162 H304 M292 169 H303" stroke="#d1ccba" stroke-width="1.4" stroke-linecap="round"/><path d="M271 159 V173" stroke="#fff" stroke-width="3" stroke-linecap="round"/>\
          </g>\
          <g class="bot-no-arms">\
            <path d="M116 217 Q130 241 153 240 L220 203" stroke="#d6d4c7" stroke-width="22" stroke-linecap="round"/><path d="M116 214 Q132 237 153 237 L219 200" stroke="#fffdf3" stroke-width="15" stroke-linecap="round"/>\
            <g transform="translate(220 201) rotate(-30)"><rect x="-3" y="-13" width="31" height="26" rx="12" fill="url(#' + id + '-shell)" stroke="#d7d2c1" stroke-width="1.3"/><path d="M19 -7 H24 M19 -1 H26 M19 5 H24" stroke="#d1ccba" stroke-width="1.4" stroke-linecap="round"/></g>\
            <path d="M244 217 Q230 241 207 240 L140 203" stroke="#d6d4c7" stroke-width="22" stroke-linecap="round"/><path d="M244 214 Q228 237 207 237 L141 200" stroke="#fffdf3" stroke-width="15" stroke-linecap="round"/>\
            <g transform="translate(140 201) rotate(30)"><rect x="-28" y="-13" width="31" height="26" rx="12" fill="url(#' + id + '-shell)" stroke="#d7d2c1" stroke-width="1.3"/><path d="M-24 -7 H-19 M-26 -1 H-19 M-24 5 H-19" stroke="#d1ccba" stroke-width="1.4" stroke-linecap="round"/></g>\
          </g>\
          <g class="bot-celebration" fill="#e7b667"><path d="M297 110 L300 102 L303 110 L311 113 L303 116 L300 124 L297 116 L289 113Z"/><path d="M61 63 L64 56 L67 63 L74 66 L67 69 L64 76 L61 69 L54 66Z"/><circle cx="311" cy="146" r="3"/><circle cx="49" cy="123" r="3"/></g>\
          <g class="bot-thought" stroke="#a8bca9" stroke-width="2" fill="#eff4e8"><circle cx="289" cy="66" r="5"/><circle cx="305" cy="47" r="10"/></g>\
          <g class="bot-zzz" fill="#93aa9c" font-family="ui-rounded, system-ui, sans-serif" font-weight="700"><text x="275" y="78" font-size="18">z</text><text x="292" y="59" font-size="24">z</text></g>\
        </g>\
      </svg>';
  }

  function earOutline(cx, cy) {
    var points = [];
    for (var i = 0; i < 24; i++) {
      var angle = Math.PI * 2 * i / 24;
      var radius = i % 2 ? 24 : 26;
      points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
    }
    return points;
  }

  function fluffyEarMarkup(cx, cy, back) {
    var points = earOutline(cx, cy);
    var path = 'M' + points[0].join(' ');
    for (var i = 1; i <= points.length; i++) {
      var current = points[i % points.length];
      var previous = points[(i - 1) % points.length];
      path += ' Q' + previous.join(' ') + ' ' + [(current[0] + previous[0]) / 2, (current[1] + previous[1]) / 2].join(' ');
    }
    path += ' Z';
    return '<g class="bot-fluffy-ear"><path d="' + path + '" fill="' + (back ? '#eadbc5' : '#f7ead6') + '" stroke="#e1cfb5" stroke-width="1.2"/>' +
      '<ellipse cx="' + cx + '" cy="' + cy + '" rx="15" ry="17" fill="' + (back ? '#f2e5d1' : '#f0c7bc') + '"/>' +
      '<path d="M' + (cx - 14) + ' ' + (cy - 14) + ' l-3 -2 M' + (cx - 8) + ' ' + (cy - 20) + ' l-1 -3 M' + (cx + 7) + ' ' + (cy - 20) + ' l1 -3 M' + (cx + 16) + ' ' + (cy - 12) + ' l3 -1 M' + (cx - 19) + ' ' + (cy + 4) + ' l-3 1 M' + (cx + 19) + ' ' + (cy + 5) + ' l3 1" stroke="#fff9ee" stroke-width="2" stroke-linecap="round"/>' +
      (!back ? '<path d="M' + (cx - 6) + ' ' + (cy - 10) + ' q7 -5 12 0" fill="none" stroke="#f8dfd7" stroke-width="3" stroke-linecap="round"/>' : '') + '</g>';
  }

  function atmosphereMarkup(id) {
    return '<svg class="bot-atmosphere" viewBox="0 0 360 340" fill="none" aria-hidden="true"><defs><radialGradient id="' + id + '-ambient"><stop stop-color="#f9e9c4" stop-opacity=".65"/><stop offset="1" stop-color="#f9e9c4" stop-opacity="0"/></radialGradient></defs>' +
      '<ellipse cx="180" cy="170" rx="155" ry="145" fill="url(#' + id + '-ambient)"/>' +
      '<g class="bot-orbit" stroke="#b7cdbb" stroke-width="1.5" stroke-linecap="round"><path d="M47 169 H58 M52.5 163.5 V174.5"/><circle cx="293" cy="79" r="5"/><path d="M306 226 H317 M311.5 220.5 V231.5"/></g>' +
      '<g class="bot-orbit-secondary" fill="#e6be78"><circle cx="71" cy="85" r="3"/><circle cx="290" cy="277" r="2.5"/><circle cx="39" cy="246" r="2"/></g>' +
      '<ellipse class="bot-floor-shadow" cx="180" cy="310" rx="78" ry="12" fill="#b5ab91" opacity=".19"/>' +
      '<ellipse cx="180" cy="312" rx="120" ry="17" stroke="#e4ddca" stroke-width="1" stroke-dasharray="3 6"/></svg>';
  }

  function backMarkup(id) {
    return '<svg class="bot-svg bot-back-svg" viewBox="0 0 360 340" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs><linearGradient id="' + id + '-back-shell" x1="95" y1="60" x2="255" y2="282" gradientUnits="userSpaceOnUse"><stop stop-color="#fffef7"/><stop offset="1" stop-color="#dfdfd0"/></linearGradient><linearGradient id="' + id + '-back-gold"><stop stop-color="#ffe2ad"/><stop offset="1" stop-color="#dbb37c"/></linearGradient></defs>' +
      fluffyEarMarkup(111, 57, true) + fluffyEarMarkup(249, 57, true) +
      '<g fill="url(#' + id + '-back-shell)" stroke="#dcd8c7" stroke-width="1.3"><rect x="127" y="266" width="33" height="22" rx="12"/><rect x="200" y="266" width="33" height="22" rx="12"/><rect x="111" y="281" width="60" height="24" rx="12"/><rect x="189" y="281" width="60" height="24" rx="12"/></g>' +
      '<g stroke-linecap="round"><path d="M113 207 Q95 219 85 245 M247 207 Q265 219 275 245" stroke="#e0ddcc" stroke-width="24"/><path d="M113 207 Q95 219 85 245 M247 207 Q265 219 275 245" stroke="#f8f5e8" stroke-width="16"/></g>' +
      '<g fill="url(#' + id + '-back-shell)" stroke="#d9d4c2" stroke-width="1.2"><rect x="70" y="236" width="27" height="30" rx="12"/><rect x="263" y="236" width="27" height="30" rx="12"/></g>' +
      '<rect x="158" y="166" width="44" height="22" rx="9" fill="#d5b381"/>' +
      '<path d="M136 181 Q180 167 224 181 Q249 193 250 234 Q251 269 226 280 Q180 296 134 280 Q109 269 110 234 Q111 193 136 181Z" fill="url(#' + id + '-back-shell)" stroke="#d8d4c2" stroke-width="1.3"/>' +
      '<path d="M139 190 Q180 178 221 190 Q237 198 237 232 Q237 261 219 270 Q180 281 141 270 Q122 261 123 232 Q123 200 139 190Z" stroke="#d7d3c0" stroke-width="1.5"/>' +
      '<rect x="157" y="195" width="46" height="18" rx="9" fill="#eee4d0" stroke="#d7cbae"/><path d="M166 202 H194 M166 208 H194" stroke="#c4b59a" stroke-width="2" stroke-linecap="round"/>' +
      '<circle cx="180" cy="245" r="16" fill="#e9c895" stroke="#d9b17c" stroke-width="1.4"/><circle cx="180" cy="245" r="9" fill="#b4c3ae"/>' +
      '<path d="M144 258 L144 269 M216 258 L216 269" stroke="#c4c0ac" stroke-width="2" stroke-linecap="round"/>' +
      '<rect x="67" y="103" width="26" height="43" rx="12" fill="url(#' + id + '-back-gold)" stroke="#d1b183"/><rect x="267" y="103" width="26" height="43" rx="12" fill="url(#' + id + '-back-gold)" stroke="#d1b183"/>' +
      '<path d="M91 77 Q110 58 180 58 Q250 58 269 77 Q283 93 280 126 Q278 158 260 169 Q232 186 180 186 Q128 186 100 169 Q82 158 80 126 Q77 93 91 77Z" fill="url(#' + id + '-back-shell)" stroke="#d8d4c2" stroke-width="1.4"/>' +
      '<path d="M104 83 Q127 70 180 70 Q233 70 256 83 Q269 95 269 124 Q267 149 252 159 Q228 173 180 173 Q132 173 108 159 Q93 149 91 124 Q91 97 104 83Z" stroke="#dcd8c7" stroke-width="1.5"/>' +
      '<path d="M139 127 H221 M144 135 H216 M150 143 H210" stroke="#c8c6b6" stroke-width="4" stroke-linecap="round"/>' +
      '<path d="M120 87 Q145 77 173 79" stroke="#fff" stroke-width="4" stroke-linecap="round"/>' +
      '<circle cx="109" cy="150" r="2.5" fill="#c4c0ab"/><circle cx="251" cy="150" r="2.5" fill="#c4c0ab"/>' +
      '<g transform="translate(180 99)"><path d="M0 8 C-8 3 -13 -3 -8 -7 Q-3 -10 0 -5 Q3 -10 8 -7 C13 -3 8 3 0 8Z" fill="#a8bca2"/><path d="M-6 -4 Q-3 -6 -2 -3" stroke="#d9e6cf" stroke-width="1.5" stroke-linecap="round"/></g>' +
      '<path d="M119 297 H161 M199 297 H241" stroke="#c6c1ae" stroke-width="3" stroke-linecap="round"/>' +
      '</svg>';
  }

  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function multiply(a, n) { return [a[0] * n, a[1] * n, a[2] * n]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function magnitude(a) { return Math.sqrt(dot(a, a)); }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function unit(a) { return multiply(a, 1 / (magnitude(a) || 1)); }
  function rounded(n) { return Math.round(n * 10000) / 10000; }

  // Every panel is a real 3D surface. SVG caps supply the front/back artwork;
  // a curved perimeter mesh joins them, so a 90-degree view still has a shell.
  function panelMarkup(points, color, extraClass) {
    var origin = points[0];
    var u = unit(subtract(points[1], origin));
    var diagonal = subtract(points[points.length - 1], origin);
    var v = unit(subtract(diagonal, multiply(u, dot(diagonal, u))));
    var normal = cross(u, v);
    var coords = points.map(function (point) {
      var relative = subtract(point, origin);
      return [dot(relative, u), dot(relative, v)];
    });
    var minX = Math.min.apply(null, coords.map(function (p) { return p[0]; }));
    var maxX = Math.max.apply(null, coords.map(function (p) { return p[0]; }));
    var minY = Math.min.apply(null, coords.map(function (p) { return p[1]; }));
    var maxY = Math.max.apply(null, coords.map(function (p) { return p[1]; }));
    var width = maxX - minX;
    var height = maxY - minY;
    if (width < .01 || height < .01) return '';
    origin = add(origin, add(multiply(u, minX), multiply(v, minY)));
    var matrix = [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, normal[0], normal[1], normal[2], 0, origin[0], origin[1], origin[2], 1].map(rounded).join(',');
    var clip = coords.map(function (p) { return rounded((p[0] - minX) / width * 100) + '% ' + rounded((p[1] - minY) / height * 100) + '%'; }).join(',');
    return '<i aria-hidden="true" class="bot-shell-face ' + (extraClass || '') + '" style="width:' + rounded(width + .12) + 'px;height:' + rounded(height + .12) + 'px;background:' + color + ';clip-path:polygon(' + clip + ');transform:matrix3d(' + matrix + ')"></i>';
  }

  function roundedOutline(x, y, width, height, radius) {
    var points = [];
    var centers = [[x + width - radius, y + radius], [x + width - radius, y + height - radius], [x + radius, y + height - radius], [x + radius, y + radius]];
    for (var side = 0; side < 4; side++) {
      for (var step = 0; step <= 4; step++) {
        var angle = (-Math.PI / 2) + side * Math.PI / 2 + step / 4 * Math.PI / 2;
        points.push([centers[side][0] + Math.cos(angle) * radius, centers[side][1] + Math.sin(angle) * radius]);
      }
    }
    var smoothPoints = [];
    for (var i = 0; i < points.length; i++) {
      var next = points[(i + 1) % points.length];
      smoothPoints.push(points[i]);
      if (Math.hypot(next[0] - points[i][0], next[1] - points[i][1]) > 28) {
        smoothPoints.push([(next[0] + points[i][0]) / 2, (next[1] + points[i][1]) / 2]);
      }
    }
    return smoothPoints;
  }

  function shellMarkup(points, cx, cy, color, depth, bevel) {
    var markup = '';
    // A single curved wall per perimeter segment avoids thousands of GPU layers.
    // These four points are coplanar because their XY endpoints are identical.
    var levels = [[-depth, 1], [depth, 1]];
    var halfHeight = Math.max.apply(null, points.map(function (p) { return Math.abs(p[1] - cy); }));
    function curvedDepth(point, z) {
      var heightRatio = (point[1] - cy) / (halfHeight || 1);
      return z * Math.sqrt(Math.max(.025, 1 - heightRatio * heightRatio * .975));
    }
    for (var layer = 0; layer < levels.length - 1; layer++) {
      for (var i = 0; i < points.length; i++) {
        var a = points[i];
        var b = points[(i + 1) % points.length];
        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < .01) continue;
        var lo = levels[layer];
        var hi = levels[layer + 1];
        var shade = .86 + Math.max(0, (a[0] - cx) / 120) * .11 + (layer === 1 ? 0 : .035);
        var rgb = color.map(function (c) { return Math.round(Math.min(255, c * shade)); });
        var vertices = [
          [cx + (a[0] - cx) * lo[1], cy + (a[1] - cy) * lo[1], curvedDepth(a, lo[0])],
          [cx + (b[0] - cx) * lo[1], cy + (b[1] - cy) * lo[1], curvedDepth(b, lo[0])],
          [cx + (b[0] - cx) * hi[1], cy + (b[1] - cy) * hi[1], curvedDepth(b, hi[0])],
          [cx + (a[0] - cx) * hi[1], cy + (a[1] - cy) * hi[1], curvedDepth(a, hi[0])]
        ];
        var paint = 'linear-gradient(0deg,rgb(' + rgb.join(',') + '),rgb(' + rgb.map(function (c) { return Math.min(255, c + 11); }).join(',') + '))';
        markup += panelMarkup(vertices, paint);
      }
    }
    return markup;
  }

  function sidePanelsMarkup(id) {
    var markup = '';
    var parts = [
      { offset: 104, name: 'head', art: '<ellipse cx="180" cy="122" rx="46" ry="64" fill="#f8f5e7" stroke="#d7d0bd" stroke-width="1.5"/><path d="M153 86 Q141 103 145 126" stroke="#fffdf5" stroke-width="4" stroke-linecap="round"/><path d="M198 91 Q214 118 202 147" stroke="#e5dfcd" stroke-width="2" stroke-linecap="round"/>' },
      { offset: 116, name: 'earphone', art: '<ellipse cx="180" cy="124" rx="22" ry="22" fill="#efd6a6" stroke="#cfae7b" stroke-width="1.5"/><ellipse cx="180" cy="124" rx="15" ry="15" fill="#f8e8c8" stroke="#e0c599" stroke-width="1"/><path d="M175 116 V132 M181 114 V134 M187 117 V131" stroke="#bfa273" stroke-width="2" stroke-linecap="round"/>' },
      { offset: 97, name: 'ear', art: '<path d="M181 30 Q188 28 192 35 Q199 34 202 42 Q207 47 204 53 Q209 60 204 66 Q205 74 197 77 Q192 85 185 82 Q176 85 171 78 Q162 78 160 70 Q155 63 159 56 Q156 48 163 43 Q164 34 172 35 Q175 29 181 30Z" fill="#f3e3ca" stroke="#d9c5a6" stroke-width="1.3"/><ellipse cx="182" cy="57" rx="14" ry="18" fill="#faedda"/><path d="M171 41 l-3 -2 M188 38 l2 -3 M199 51 l3 -1 M169 70 l-3 1 M197 69 l3 1" stroke="#fff9ec" stroke-width="2.5" stroke-linecap="round"/>' },
      { offset: 74, name: 'body', art: '<ellipse cx="180" cy="233" rx="40" ry="56" fill="#f8f4e4" stroke="#d6ceba" stroke-width="1.5"/><path d="M159 193 Q148 210 148 232" stroke="#fffdf3" stroke-width="4" stroke-linecap="round"/><path d="M194 193 Q209 225 200 255" stroke="#e6dfcc" stroke-width="2" stroke-linecap="round"/><circle cx="180" cy="211" r="12" fill="#eccb95" stroke="#d0af7a" stroke-width="1.4"/><circle cx="180" cy="211" r="6" fill="#fbefd0"/><path d="M179 223 Q180 238 190 247" stroke="#d4c7af" stroke-width="15" stroke-linecap="round"/><path d="M177 223 Q178 238 188 247" stroke="#fff9e9" stroke-width="10" stroke-linecap="round"/>' },
      { offset: 112, name: 'hand', art: '<ellipse cx="193" cy="252" rx="16" ry="15" fill="#fff9e9" stroke="#d2c6ae" stroke-width="1.6"/><path d="M187 262 V266 M193 263 V267 M200 260 V264" stroke="#c0b49a" stroke-width="1.5" stroke-linecap="round"/><path d="M202 243 Q209 242 211 249 Q211 255 205 256" fill="#f4ead4" stroke="#d2c6ae" stroke-width="1.3"/>' },
      { offset: 73, name: 'foot', art: '<rect x="171" y="267" width="18" height="24" rx="8" fill="#dfc398" stroke="#cbae7f" stroke-width="1"/><ellipse cx="180" cy="294" rx="35" ry="12" fill="#fff9ea" stroke="#cfc6b1" stroke-width="1.5"/><path d="M151 299 Q180 307 209 298" stroke="#d2c9b5" stroke-width="3" stroke-linecap="round"/><path d="M189 286 Q199 286 205 290" stroke="#fff" stroke-width="3" stroke-linecap="round"/>' }
    ];
    [-1, 1].forEach(function (side) {
      parts.forEach(function (part) {
        markup += '<div aria-hidden="true" class="bot-plane bot-plane-side bot-side-' + part.name + '" style="transform:translateX(' + (side * part.offset) + 'px) rotateY(' + (side * 90) + 'deg)"><svg class="bot-svg" viewBox="0 0 360 340" fill="none" xmlns="http://www.w3.org/2000/svg">' + part.art + '</svg></div>';
      });
    });
    return markup;
  }

  function triangleMarkup(a, b, c, color) { return panelMarkup([a, b, c], color, 'bot-tail-face'); }

  function tailMarkup() {
    var markup = '';
    var curve = [[180, 245, -44], [190, 248, -60], [203, 245, -80], [207, 231, -99], [199, 219, -115], [186, 211, -128]];
    var rings = [];
    for (var i = 0; i < curve.length; i++) {
      var tangent = unit(subtract(curve[Math.min(i + 1, curve.length - 1)], curve[Math.max(0, i - 1)]));
      var horizontal = unit(cross(tangent, [0, 1, 0]));
      var vertical = unit(cross(tangent, horizontal));
      var radius = i === 0 ? 8 : 6.5;
      var ring = [];
      for (var j = 0; j < 8; j++) {
        var angle = j * Math.PI * 2 / 8;
        ring.push(add(curve[i], add(multiply(horizontal, Math.cos(angle) * radius), multiply(vertical, Math.sin(angle) * radius))));
      }
      rings.push(ring);
    }
    for (var segment = 0; segment < rings.length - 1; segment++) {
      for (var side = 0; side < 8; side++) {
        var next = (side + 1) % 8;
        var shade = Math.round(218 + 19 * Math.cos(side * Math.PI * 2 / 8));
        var color = 'rgb(' + (shade + 8) + ',' + shade + ',' + (shade - 17) + ')';
        markup += triangleMarkup(rings[segment][side], rings[segment][next], rings[segment + 1][next], color);
        markup += triangleMarkup(rings[segment][side], rings[segment + 1][next], rings[segment + 1][side], color);
      }
    }
    var center = [186, 209, -130];
    var latitudes = 4;
    var longitudes = 10;
    function spherePoint(latitude, longitude) {
      var phi = Math.PI * latitude / latitudes;
      var theta = Math.PI * 2 * longitude / longitudes;
      var fluff = latitude === 0 || latitude === latitudes ? 1 : 1 + .025 * Math.cos(longitude * 3 + latitude * 2);
      return [center[0] + Math.sin(phi) * Math.cos(theta) * 17 * fluff, center[1] + Math.cos(phi) * 18 * fluff, center[2] + Math.sin(phi) * Math.sin(theta) * 17 * fluff];
    }
    for (var lat = 0; lat < latitudes; lat++) {
      for (var lon = 0; lon < longitudes; lon++) {
        var a = spherePoint(lat, lon);
        var b = spherePoint(lat, lon + 1);
        var c = spherePoint(lat + 1, lon + 1);
        var d = spherePoint(lat + 1, lon);
        var luminance = Math.round(230 + Math.sin(lon / longitudes * Math.PI * 2) * 11 - lat * 1.5);
        var ballColor = 'rgb(' + Math.min(255, luminance + 13) + ',' + luminance + ',' + (luminance - 17) + ')';
        if (lat > 0) markup += triangleMarkup(a, b, c, ballColor);
        if (lat < latitudes - 1) markup += triangleMarkup(a, c, d, ballColor);
      }
    }
    return '<div class="bot-tail-mesh" aria-hidden="true">' + markup + '</div>';
  }

  function robotMarkup(id, small) {
    if (small) return atmosphereMarkup(id) + frontMarkup(id);
    var shell = shellMarkup(roundedOutline(80, 58, 200, 128, 30), 180, 122, [248, 247, 230], 44, 10) +
      shellMarkup(roundedOutline(110, 178, 140, 110, 34), 180, 233, [248, 245, 228], 44, 12) +
      shellMarkup(roundedOutline(111, 281, 60, 24, 11), 141, 293, [245, 243, 222], 44, 7) +
      shellMarkup(roundedOutline(189, 281, 60, 24, 11), 219, 293, [245, 243, 222], 44, 7) +
      shellMarkup(earOutline(111, 57), 111, 57, [248, 229, 202], 28, 8) +
      shellMarkup(earOutline(249, 57), 249, 57, [248, 229, 202], 28, 8);
    return '<div class="bot-stage">' + atmosphereMarkup(id) + '<div class="bot-turntable"><div class="bot-lift"><div class="bot-solid">' +
      '<div class="bot-mesh" aria-hidden="true">' + shell + '</div>' + tailMarkup() + sidePanelsMarkup(id) +
      '<div class="bot-plane bot-plane-front">' + frontMarkup(id) + '</div><div class="bot-plane bot-plane-back">' + backMarkup(id) + '</div>' +
      '</div></div></div></div><span class="bot-view-label" aria-live="polite">皮皮的正面</span>';
  }

  function mount(container, options) {
    if (typeof container === 'string') container = document.querySelector(container);
    if (!container || typeof container.appendChild !== 'function') {
      throw new TypeError('RobotCompanion.mount needs a DOM container.');
    }
    var previous = instances.get(container);
    if (previous) previous.destroy();
    options = options || {};
    var small = options.size === 'small';
    var id = 'spark-robot-' + (++sequence);
    var element = document.createElement('div');
    element.className = 'robot-companion robot-companion--' + (small ? 'small' : 'hero');
    element.dataset.emotion = 'happy';
    element.innerHTML = robotMarkup(id, small);
    element.style.setProperty('--bot-lens', 'url(#' + id + '-lens)');
    if (!small) {
      element.tabIndex = 0;
      element.setAttribute('role', 'group');
      element.setAttribute('aria-label', '皮皮，拖动查看全身。左右方向键旋转，Home 键回到正面。');
      element.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Home');
    }
    container.appendChild(element);
    var timer = null;
    var frame = null;
    var spinFrame = null;
    var destroyed = false;
    var yaw = 0;
    var drag = null;
    var suppressClickUntil = 0;
    var resizeObserver = null;
    var viewLabel = element.querySelector('.bot-view-label');
    var title = element.querySelector('title');
    var head = element.querySelector('.bot-head');
    var armLeft = element.querySelector('.bot-arm-left');
    var armRight = element.querySelector('.bot-arm-right');
    var angles = {
      happy: [0, -13, 0], excited: [80, -80, -3], thinking: [0, -42, -5],
      proud: [0, 0, -3], angry: [-17, 17, 0], sorry: [-14, 14, 5],
      no: [0, 0, 0], sleepy: [-7, 7, 5]
    };

    function setEmotion(emotion) {
      if (destroyed) return;
      if (!Object.prototype.hasOwnProperty.call(descriptions, emotion)) emotion = 'happy';
      element.dataset.emotion = emotion;
      title.textContent = '皮皮：' + descriptions[emotion];
      var pose = angles[emotion];
      armLeft.setAttribute('transform', 'rotate(' + pose[0] + ')');
      armRight.setAttribute('transform', 'rotate(' + pose[1] + ')');
      head.setAttribute('transform', 'rotate(' + pose[2] + ' 180 130)');
      element.classList.remove('is-reacting');
      if (timer !== null) window.clearTimeout(timer);
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(function () {
        if (destroyed) return;
        element.classList.add('is-reacting');
        timer = window.setTimeout(function () {
          if (!destroyed) element.classList.remove('is-reacting');
          timer = null;
        }, 650);
        frame = null;
      });
      return emotion;
    }

    function normalizedRotation() { return ((yaw % 360) + 360) % 360; }
    function updateRotation(degrees, announce) {
      if (destroyed || small || !Number.isFinite(degrees)) return;
      yaw = degrees;
      element.style.setProperty('--bot-yaw', yaw + 'deg');
      element.dataset.rotation = String(Math.round(normalizedRotation()));
      var angle = normalizedRotation();
      var view = angle < 45 || angle >= 315 ? '正面' : angle < 135 ? '左侧' : angle < 225 ? '背面' : '右侧';
      element.dataset.view = view;
      if (announce && viewLabel) viewLabel.textContent = '皮皮的' + view;
    }

    function stopSpin() {
      if (spinFrame !== null) window.cancelAnimationFrame(spinFrame);
      spinFrame = null;
      element.classList.remove('is-spinning');
    }

    function animateRotation(target, duration) {
      if (destroyed || small) return;
      stopSpin();
      var initial = yaw;
      var started = null;
      var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reducedMotion || duration === 0) { updateRotation(target, true); return; }
      element.classList.add('is-spinning');
      function tick(now) {
        if (destroyed) return;
        if (started === null) started = now;
        var progress = Math.min(1, (now - started) / duration);
        var eased = progress < .5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        updateRotation(initial + (target - initial) * eased, progress === 1);
        if (progress < 1) spinFrame = window.requestAnimationFrame(tick);
        else {
          spinFrame = null;
          element.classList.remove('is-spinning');
          updateRotation(normalizedRotation(), true);
        }
      }
      spinFrame = window.requestAnimationFrame(tick);
    }

    function spin(config) {
      var duration = typeof config === 'number' ? config : config && config.duration;
      if (!Number.isFinite(duration)) duration = 2200;
      duration = Math.max(0, Math.min(10000, duration));
      animateRotation(yaw + 360, duration);
    }

    function resetRotation(config) {
      var duration = typeof config === 'number' ? config : config && config.duration;
      if (!Number.isFinite(duration)) duration = 550;
      var nearestFront = Math.round(yaw / 360) * 360;
      animateRotation(nearestFront, Math.max(0, Math.min(10000, duration)));
    }

    function resize() {
      if (!small) element.style.setProperty('--bot-scale', String((element.clientWidth || 360) / 360));
    }

    function pointerDown(event) {
      if (small || event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
      stopSpin();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, yaw: yaw, moved: false };
      if (element.setPointerCapture) element.setPointerCapture(event.pointerId);
    }

    function pointerMove(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      var dx = event.clientX - drag.x;
      var dy = event.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * .7) {
        drag.moved = true;
        element.classList.add('is-dragging');
      }
      if (drag.moved) {
        if (event.cancelable) event.preventDefault();
        updateRotation(drag.yaw + dx * 250 / (element.clientWidth || 360), false);
      }
    }

    function pointerUp(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.moved) suppressClickUntil = Date.now() + 450;
      drag = null;
      element.classList.remove('is-dragging');
      updateRotation(yaw, true);
      if (element.hasPointerCapture && element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    }

    function guardClick(event) {
      if (Date.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
      }
    }

    function keyDown(event) {
      if (event.target !== element || small) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        stopSpin();
        updateRotation(yaw + (event.key === 'ArrowLeft' ? -30 : 30), true);
      } else if (event.key === 'Home') {
        event.preventDefault();
        resetRotation();
      }
    }

    if (!small) {
      element.addEventListener('pointerdown', pointerDown);
      element.addEventListener('pointermove', pointerMove);
      element.addEventListener('pointerup', pointerUp);
      element.addEventListener('pointercancel', pointerUp);
      element.addEventListener('click', guardClick, true);
      element.addEventListener('keydown', keyDown);
      window.addEventListener('resize', resize);
      if (window.ResizeObserver) { resizeObserver = new window.ResizeObserver(resize); resizeObserver.observe(element); }
      resize();
      updateRotation(0, true);
    }

    var instance = {
      element: element,
      setEmotion: setEmotion,
      spin: spin,
      resetRotation: resetRotation,
      setRotation: function (degrees) { stopSpin(); updateRotation(Number(degrees), true); },
      getRotation: normalizedRotation,
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        if (timer !== null) window.clearTimeout(timer);
        if (frame !== null) window.cancelAnimationFrame(frame);
        stopSpin();
        if (resizeObserver) resizeObserver.disconnect();
        window.removeEventListener('resize', resize);
        element.removeEventListener('pointerdown', pointerDown);
        element.removeEventListener('pointermove', pointerMove);
        element.removeEventListener('pointerup', pointerUp);
        element.removeEventListener('pointercancel', pointerUp);
        element.removeEventListener('click', guardClick, true);
        element.removeEventListener('keydown', keyDown);
        element.remove();
        if (instances.get(container) === instance) instances.delete(container);
      }
    };
    instances.set(container, instance);
    setEmotion('happy');
    return instance;
  }

  window.RobotCompanion = { mount: mount, emotions: Object.keys(descriptions) };
})();
