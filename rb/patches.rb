# Applied after all game scripts are defined, just before "Main" runs.
# Replaces DLL-backed helpers with JS implementations.

module Hn_Rg_Bitmap
  module_function

  def blur(bitmap, r = 1) = RG.call(:blur, bitmap.id, r)
  def change_tone(bitmap, red = 0, green = 0, blue = 0, simplify = 1) = RG.call(:tone, bitmap.id, red, green, blue, simplify)
  def clip_mask(g, m, x = 0, y = 0, outer = 0) = RG.call(:clipMask, g.id, m.id, x, y, outer)
  def invert(bitmap) = RG.call(:invert, bitmap.id)
  def mosaic(bitmap, msw = 5, msh = 5) = mosaic_rect(bitmap, bitmap.rect, msw, msh)
  def mosaic_rect(bitmap, r, msw = 5, msh = 5) = RG.call(:mosaic, bitmap.id, r.x, r.y, r.width, r.height, msw, msh)
  def address(bitmap) = bitmap.id
  def get_pixel_data(bitmap) = bitmap.get_pixel_data_bgra
  def set_pixel_data(bitmap, data) = bitmap.set_pixel_data_bgra(data)
  def png_save(*_a) = 0

  def blend_blt(dest, x, y, src, r, blend_type = 0, opacity = 255)
    RG.call(:blendBlt, dest.id, x, y, src.id, r.x, r.y, r.width, r.height, blend_type, opacity)
  end
end

# ?debug: attribute wasm memory growth to the main per-frame subsystems.
if $RGSS_PROF
  module RGSSProf
    @acc = Hash.new(0)
    class << self
      attr_reader :acc
      def wrap(target, meth, label)
        orig = :"__prof_#{target.object_id}_#{meth}"
        target.alias_method(orig, meth)
        target.define_method(meth) do |*a, &b|
          m0 = RG.call(:mem).to_i
          r = __send__(orig, *a, &b)
          RGSSProf.acc[label] += RG.call(:mem).to_i - m0
          r
        end
      end
    end
  end
  [[Game_Interpreter, :update], [Game_Map, :update], [Game_Player, :update], [Spriteset_Map, :update],
   [Window_Message, :update], [Scene_Map, :update], [Game_Interpreter, :execute_command],
   [Game_Map, :update_events], [Game_Map, :update_scroll], [Game_Map, :update_parallax], [Game_Screen, :update],
   [Game_Event, :update], [Game_CommonEvent, :update], [Game_Map, :refresh], [Game_Event, :refresh],
   [Game_Character, :update], [Game_Map, :update_vehicles],
   [Game_Event, :conditions_met?], [Game_Event, :setup], [Game_Event, :clear_starting], [Game_Event, :check_event_trigger_auto],
   [Game_SelfSwitches, :[]], [Game_Switches, :[]], [Game_Variables, :[]], [Game_Party, :item_number], [Game_Party, :members]].each do |k, m|
    next unless k.method_defined?(m) || k.private_method_defined?(m)
    RGSSProf.wrap(k, m, "#{k}##{m}")
  end
  RGSSProf.wrap(Graphics.singleton_class, :draw_list, 'Graphics.draw_list')
  RGSSProf.wrap(Input.singleton_class, :update, 'Input.update')
end

#--------------------------------------------------------------------------
# Quick save / load from anywhere (page buttons, F2 / F4).
# A slot holds the game's own save data plus every other global that can be marshaled (the game keeps
# most of its state in globals). In battle the slot gets the state captured when the battle began, and
# loading it restarts that battle.
#--------------------------------------------------------------------------
require 'stringio'

class RGSSJump < Exception; end # unwinds the running scene after a quick load / reset

# Scene graph objects can't go into a save. Inside the game's own save data they are written as nil
# (the game recreates its windows when it finds them missing); globals holding them are skipped.
[Sprite, Plane, Window, Viewport, Tilemap, Tilemap::Layer].each do |k|
  k.define_method(:_dump) do |_l|
    raise TypeError, "can't dump #{self.class}" unless RGSSQuick.lenient
    ''
  end
  k.define_singleton_method(:_load) { |_s| nil }
end

module RGSSQuick
  SKIP = /\A\$(game_|data_|scene\z|RGSS|std|PROGRAM|LOAD|LOADED|DEBUG|VERBOSE|FILENAME|tec_mozi\z)/

  class << self
    attr_accessor :battle_snapshot, :lenient

    def file(slot) = "QuickSave#{slot}.rvdata"
    def in_battle? = $scene.class.name.to_s.start_with?('Scene_Db_Battle') && !$scene.is_a?(Scene_Db_Battle_arena)
    def ready? = !$data_system.nil? && !$game_party.nil? && !$game_map.nil? && $game_map.map_id.to_i > 0

    def capture(battle_args = nil)
      io = StringIO.new(''.b)
      count = $game_system.save_count
      # a message on screen carries a callback Proc, which can't be saved (the game only saved between messages)
      main_proc = $game_message.main_proc
      $game_message.main_proc = nil
      self.lenient = true
      begin
        Scene_File.allocate.send(:write_save_data, io)
      ensure
        self.lenient = false
        $game_message.main_proc = main_proc
        $game_system.save_count = count
      end
      globals = {}
      global_variables.each do |g|
        next if g.to_s !~ /\A\$[A-Za-z_]\w*\z/ || g.to_s =~ SKIP
        v = eval(g.to_s)
        next if v.nil?
        begin
          globals[g] = Marshal.dump(v)
        rescue StandardError
          next
        end
      end
      info = describe + (battle_args ? '（戰鬥開始時）' : '')
      Zlib::Deflate.deflate(Marshal.dump({ 'v' => 1, 'game' => io.string, 'globals' => globals,
                                           'battle' => battle_args, 'info' => info }))
    end

    def describe
      name = (load_data('Data/MapInfos.rvdata')[$game_map.map_id].name rescue '').to_s
      sec = Graphics.frame_count / 60
      format('%s　遊戲時間 %d:%02d', name, sec / 3600, sec / 60 % 60)
    end

    # Cutscene pictures are drawn by script calls like "$eve.z1opening 9" and aren't part of a save.
    # After loading mid-cutscene, re-run the last such call once the map scene is up.
    def last_cutscene_command
      it = $game_map.interpreter
      list = it.instance_variable_get(:@list)
      return nil unless list
      i = it.instance_variable_get(:@index).to_i
      while i > 0
        i -= 1
        c = list[i]
        next unless c && c.code == 355
        script = c.parameters[0].to_s.dup
        j = i + 1
        while list[j] && list[j].code == 655
          script << "\n" << list[j].parameters[0].to_s
          j += 1
        end
        return script if script.include?('$eve.')
      end
      nil
    end

    def tick
      return unless @replay && $scene.is_a?(Scene_Map)
      @replay_wait = (@replay_wait || 0) + 1
      return if @replay_wait < 2
      script = @replay
      @replay = nil
      @replay_wait = 0
      begin
        $game_map.interpreter.__send__(:rgss_eval, script)
      rescue StandardError => e
        RG.call(:warn, "cutscene replay failed: #{e.message}")
      end
    end

    def handle
      return if @busy
      op, slot = RG.call(:takeReq).to_s.split(':')
      return unless op
      @busy = true
      begin
        op == 'save' ? save(slot.to_i) : load(slot.to_i)
      rescue StandardError => e
        RG.call(:warn, "quick #{op} failed: #{e.class}: #{e.message}\n#{(e.backtrace || []).first(6).join("\n")}")
        result(op, slot.to_i, false, op == 'save' ? '存檔失敗' : '讀檔失敗')
      ensure
        @busy = false
      end
    end

    def save(slot)
      return result('save', slot, false, '遊戲還沒開始，無法存檔') unless ready?
      data = in_battle? ? battle_snapshot : capture
      return result('save', slot, false, '目前無法存檔') unless data
      File.binwrite(file(slot), data)
      RG.call(:persist, file(slot))
      info = Marshal.load(Zlib::Inflate.inflate(data))['info']
      result('save', slot, true, info)
    end

    def load(slot)
      return result('load', slot, false, '這個欄位沒有存檔') unless File.file?(file(slot)) && File.size(file(slot)) > 0
      return result('load', slot, false, '請先進入標題畫面再讀檔') if $data_system.nil?
      snap = Marshal.load(Zlib::Inflate.inflate(File.binread(file(slot))))
      snap['globals'].each do |g, d|
        begin
          eval("#{g} = Marshal.load(d)")
        rescue StandardError
          next
        end
      end
      Audio.bgs_stop
      Audio.me_stop
      Audio.se_stop
      if snap['battle']
        Scene_File.allocate.send(:read_save_data, StringIO.new(snap['game']))
        KGC::LimitBreak.set_enemy_parameters
        KGC::LimitBreak.revise_enemy_parameters
        $scene = Scene_Db_Battle.new(*snap['battle'])
      else
        File.binwrite('QuickLoad.tmp', snap['game'])
        sf = Scene_File.allocate
        sf.instance_variable_set(:@savefile_windows, [Struct.new(:filename).new('QuickLoad.tmp')])
        sf.instance_variable_set(:@index, 0)
        sf.instance_variable_set(:@new_game_plus_flag, false)
        sf.send(:do_load)
      end
      release_message_waits
      $eve ||= Event_Main.new
      @replay = snap['battle'] ? nil : last_cutscene_command
      result('load', slot, true, snap['info'])
      raise RGSSJump
    end

    def result(op, slot, ok, msg) = RG.call(:quickResult, op, slot, ok ? 1 : 0, msg.to_s)

    # A save made while a message was showing has interpreters waiting for it to close; the callback that
    # would release them (Game_Message#main_proc) can't be saved, so hook up a new one.
    def release_message_waits
      interps = [$game_map.interpreter]
      $game_map.events.each_value { |e| interps << e.instance_variable_get(:@interpreter) }
      ($game_map.instance_variable_get(:@common_events) || {}).each_value { |e| interps << e.instance_variable_get(:@interpreter) }
      all = []
      until interps.empty?
        i = interps.shift
        next unless i
        all << i
        interps << i.instance_variable_get(:@child_interpreter)
      end
      waiting = all.select { |i| i.instance_variable_get(:@message_waiting) }
      return if waiting.empty?
      release = proc { waiting.each { |i| i.instance_variable_set(:@message_waiting, false) } }
      $game_message.texts.empty? ? release.call : ($game_message.main_proc = release)
    end
  end
end

class Scene_Db_Battle
  alias_method :__rgss_quick_initialize, :initialize
  def initialize(*args)
    @rgss_battle_args = args
    __rgss_quick_initialize(*args)
  end

  alias_method :__rgss_quick_main, :main
  def main
    RGSSQuick.battle_snapshot = (RGSSQuick.capture(@rgss_battle_args) rescue nil)
    __rgss_quick_main
  end
end
