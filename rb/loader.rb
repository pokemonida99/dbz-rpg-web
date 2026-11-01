# Loads Data/Scripts.rvdata and runs the game, like Game.exe does.
Dir.chdir('/game')
$RGSS_SCRIPTS = load_data('Data/Scripts.rvdata')

# Source-level fixes applied to individual game scripts before they run.
# script name => [[original text, replacement], ...]
RGSS_SRC_PATCHES = {
  # cache compiled event scripts (see RGSSEvalCache)
  'Game_Interpreter' => [
    ["result = eval(@params[1])", "result = rgss_eval(@params[1])"],
    # a "wait" right before the next line of dialogue is just dead air between lines; keep it short
    ["  def command_230\n    @wait_count = @params[0]\n",
     "  def command_230\n    @wait_count = @params[0]\n    nxt = @list[@index + 1, 2].to_a.map(&:code)\n    @wait_count = [@wait_count, 6].min if nxt.include?(101)\n"],
    ["      eval(script)\n", "      rgss_eval(script)\n"],
  ],
  'Game_Character' => [
    ["eval(command.parameters[0])", "rgss_eval(command.parameters[0])"],
  ],
  # FC-style menu text is laid out on a 16px grid; draw the CJK glyphs at 16px so they don't overlap.
  'Extension' => [
    ["$tec_mozi.font.size = 24\n    $tec_mozi.draw_text(16 * x, -1, 32, 32, itimozi)",
     "$tec_mozi.font.size = 16\n    $tec_mozi.draw_text(16 * x, 0, 32, 24, itimozi)"],
    # convert the whole string to Traditional before it is drawn one character at a time
    ["  mozi = convert_special_characters mozi\n  mozi_num = mozi.split(//u).size\n  #p mozi,mozi_num\n  $tec_mozi=Bitmap.new(24*(mozi_num)+24, 24)\n  $tec_mozi.set_text_content(mozi)",
     "  mozi = rgss_s2t(convert_special_characters(mozi))\n  mozi_num = mozi.split(//u).size\n  $tec_mozi=Bitmap.new(24*(mozi_num)+24, 24)\n  $tec_mozi.set_text_content(mozi)"],
  ],
  # message window text is also drawn character by character
  'Window_Message' => [
    # the dialogue is full of \. (1/4 s) and \| (1 s) pauses; keep a hint of the rhythm but not the drag
    ["@wait_count = 15 if $game_switches[482] == false", "@wait_count = 5 if $game_switches[482] == false"],
    ["@wait_count = 60 if $game_switches[482] == false", "@wait_count = 15 if $game_switches[482] == false"],
    ['@text += $game_message.texts[i].clone + "\x00"', '@text += rgss_s2t($game_message.texts[i].clone) + "\x00"'],
  ],
}

def rgss_patch_source(name, src)
  (RGSS_SRC_PATCHES[name] || []).each do |from, to|
    if src.include?(from)
      src = src.sub(from) { to }
    else
      RG.call(:warn, "source patch did not apply: #{name}")
    end
  end
  src
end

def rgss_run_scripts
  $RGSS_SCRIPTS.each_with_index do |(_id, name, code), i|
    name = name.to_s.force_encoding('UTF-8')
    src = Zlib::Inflate.inflate(code).force_encoding('UTF-8').gsub("\r\n", "\n")
    next if src.strip.empty?
    src = rgss_patch_source(name, src)
    eval(RG.call(:patchesFor, 'before', name).to_s, TOPLEVEL_BINDING, "patch:#{name}") if name == 'Main'
    eval(src, TOPLEVEL_BINDING, format('%03d:%s', i, name))
  end
end

# Keeps running scenes after a quick load (RGSSJump) or F12 reset abandons the current one.
def rgss_main_loop
  loop do
    begin
      $scene.main while $scene != nil
      break
    rescue RGSSJump
      Graphics.reset_scene_graph
    rescue RGSSReset
      Graphics.reset_scene_graph
      Audio.bgm_stop
      $scene = Scene_Title.new
    end
  end
end

begin
  begin
    rgss_run_scripts
  rescue RGSSJump
    Graphics.reset_scene_graph
  rescue RGSSReset
    Graphics.reset_scene_graph
    Audio.bgm_stop
    $scene = Scene_Title.new
  end
  rgss_main_loop
rescue SystemExit => e
  RG.call(:halt, (e.backtrace || []).first(8).join("\n"))
rescue Exception => e
  msg = "#{e.class}: #{e.message}\n" + (e.backtrace || []).first(25).join("\n")
  RG.call(:fatal, msg)
end
