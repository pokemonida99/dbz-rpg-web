# RGSS2 built-in RPG module (data structures used by the .rvdata files).
module RPG
  class AudioFile
    attr_accessor :name, :volume, :pitch
    def initialize(name = '', volume = 100, pitch = 100)
      @name, @volume, @pitch = name, volume, pitch
    end
  end

  class BGM < AudioFile
    @@last = BGM.new
    def play
      if @name.empty?
        Audio.bgm_stop
        @@last = BGM.new
      else
        Audio.bgm_play('Audio/BGM/' + @name, @volume, @pitch)
        @@last = self
      end
    end
    def self.stop = (Audio.bgm_stop; @@last = BGM.new)
    def self.fade(t) = (Audio.bgm_fade(t); @@last = BGM.new)
    def self.last = @@last
  end

  class BGS < AudioFile
    @@last = BGS.new
    def play
      if @name.empty?
        Audio.bgs_stop
        @@last = BGS.new
      else
        Audio.bgs_play('Audio/BGS/' + @name, @volume, @pitch)
        @@last = self
      end
    end
    def self.stop = (Audio.bgs_stop; @@last = BGS.new)
    def self.fade(t) = (Audio.bgs_fade(t); @@last = BGS.new)
    def self.last = @@last
  end

  class ME < AudioFile
    def play
      @name.empty? ? Audio.me_stop : Audio.me_play('Audio/ME/' + @name, @volume, @pitch)
    end
    def self.stop = Audio.me_stop
    def self.fade(t) = Audio.me_fade(t)
  end

  class SE < AudioFile
    def play
      Audio.se_play('Audio/SE/' + @name, @volume, @pitch) unless @name.empty?
    end
    def self.stop = Audio.se_stop
  end

  class Map
    attr_accessor :width, :height, :scroll_type, :autoplay_bgm, :bgm, :autoplay_bgs, :bgs,
                  :disable_dashing, :encounter_list, :encounter_step, :parallax_name,
                  :parallax_loop_x, :parallax_loop_y, :parallax_sx, :parallax_sy, :parallax_show,
                  :data, :events
    def initialize(width, height)
      @width, @height = width, height
      @scroll_type = 0
      @autoplay_bgm = false
      @bgm = BGM.new
      @autoplay_bgs = false
      @bgs = BGS.new('', 80)
      @disable_dashing = false
      @encounter_list = []
      @encounter_step = 30
      @parallax_name = ''
      @parallax_loop_x = @parallax_loop_y = false
      @parallax_sx = @parallax_sy = 0
      @parallax_show = false
      @data = Table.new(width, height, 3)
      @events = {}
    end
  end

  class MapInfo
    attr_accessor :name, :parent_id, :order, :expanded, :scroll_x, :scroll_y
    def initialize
      @name = ''
      @parent_id = 0
      @order = 0
      @expanded = false
      @scroll_x = @scroll_y = 0
    end
  end

  class Area
    attr_accessor :id, :name, :map_id, :rect, :encounter_list, :order
    def initialize
      @id = 0
      @name = ''
      @map_id = 0
      @rect = Rect.new(0, 0, 0, 0)
      @encounter_list = []
      @order = 0
    end
  end

  class Event
    attr_accessor :id, :name, :x, :y, :pages
    def initialize(x, y)
      @id = 0
      @name = ''
      @x, @y = x, y
      @pages = [Page.new]
    end

    class Page
      attr_accessor :condition, :graphic, :move_type, :move_speed, :move_frequency, :move_route,
                    :walk_anime, :step_anime, :direction_fix, :through, :priority_type,
                    :trigger, :list
      def initialize
        @condition = Condition.new
        @graphic = Graphic.new
        @move_type = 0
        @move_speed = 3
        @move_frequency = 3
        @move_route = MoveRoute.new
        @walk_anime = true
        @step_anime = false
        @direction_fix = false
        @through = false
        @priority_type = 0
        @trigger = 0
        @list = [EventCommand.new]
      end

      class Condition
        attr_accessor :switch1_valid, :switch2_valid, :variable_valid, :self_switch_valid,
                      :item_valid, :actor_valid, :switch1_id, :switch2_id, :variable_id,
                      :variable_value, :self_switch_ch, :item_id, :actor_id
        def initialize
          @switch1_valid = @switch2_valid = @variable_valid = @self_switch_valid = false
          @item_valid = @actor_valid = false
          @switch1_id = @switch2_id = @variable_id = 1
          @variable_value = 0
          @self_switch_ch = 'A'
          @item_id = @actor_id = 1
        end
      end

      class Graphic
        attr_accessor :tile_id, :character_name, :character_index, :direction, :pattern
        def initialize
          @tile_id = 0
          @character_name = ''
          @character_index = 0
          @direction = 2
          @pattern = 0
        end
      end
    end
  end

  class EventCommand
    attr_accessor :code, :indent, :parameters
    def initialize(code = 0, indent = 0, parameters = [])
      @code, @indent, @parameters = code, indent, parameters
    end
  end

  class MoveRoute
    attr_accessor :repeat, :skippable, :wait, :list
    def initialize
      @repeat = true
      @skippable = false
      @wait = false
      @list = [MoveCommand.new]
    end
  end

  class MoveCommand
    attr_accessor :code, :parameters
    def initialize(code = 0, parameters = [])
      @code, @parameters = code, parameters
    end
  end

  class Actor
    attr_accessor :id, :name, :class_id, :initial_level, :exp_basis, :exp_inflation,
                  :character_name, :character_index, :face_name, :face_index, :parameters,
                  :weapon_id, :armor1_id, :armor2_id, :armor3_id, :armor4_id,
                  :two_swords_style, :fix_equipment, :auto_battle, :super_guard,
                  :pharmacology, :critical_bonus
    def initialize
      @id = 0
      @name = ''
      @class_id = 1
      @initial_level = 1
      @exp_basis = 25
      @exp_inflation = 35
      @character_name = ''
      @character_index = 0
      @face_name = ''
      @face_index = 0
      @parameters = Table.new(6, 100)
      @weapon_id = @armor1_id = @armor2_id = @armor3_id = @armor4_id = 0
      @two_swords_style = @fix_equipment = @auto_battle = @super_guard = false
      @pharmacology = @critical_bonus = false
    end
  end

  class Class
    attr_accessor :id, :name, :position, :weapon_set, :armor_set, :element_ranks,
                  :state_ranks, :learnings, :skill_name_valid, :skill_name
    def initialize
      @id = 0
      @name = ''
      @position = 0
      @weapon_set = []
      @armor_set = []
      @element_ranks = Table.new(1)
      @state_ranks = Table.new(1)
      @learnings = []
      @skill_name_valid = false
      @skill_name = ''
    end

    class Learning
      attr_accessor :level, :skill_id
      def initialize
        @level = 1
        @skill_id = 1
      end
    end
  end

  class BaseItem
    attr_accessor :id, :name, :icon_index, :description, :note
    def initialize
      @id = 0
      @name = ''
      @icon_index = 0
      @description = ''
      @note = ''
    end
  end

  class UsableItem < BaseItem
    attr_accessor :scope, :occasion, :speed, :animation_id, :common_event_id, :base_damage,
                  :variance, :atk_f, :spi_f, :physical_attack, :damage_to_mp, :absorb_damage,
                  :ignore_defense, :element_set, :plus_state_set, :minus_state_set
    def initialize
      super
      @scope = 0
      @occasion = 0
      @speed = 0
      @animation_id = 0
      @common_event_id = 0
      @base_damage = 0
      @variance = 20
      @atk_f = 0
      @spi_f = 0
      @physical_attack = @damage_to_mp = @absorb_damage = @ignore_defense = false
      @element_set = []
      @plus_state_set = []
      @minus_state_set = []
    end
    def for_opponent? = [1, 2, 3, 4, 5, 6].include?(@scope)
    def for_friend? = [7, 8, 9, 10, 11].include?(@scope)
    def for_dead_friend? = [9, 10].include?(@scope)
    def for_user? = [11].include?(@scope)
    def for_one? = [1, 3, 4, 7, 9, 11].include?(@scope)
    def for_two? = [5].include?(@scope)
    def for_three? = [6].include?(@scope)
    def for_random? = [4, 5, 6].include?(@scope)
    def for_all? = [2, 8, 10].include?(@scope)
    def dual? = [3].include?(@scope)
    def need_selection? = [1, 3, 7, 9].include?(@scope)
    def battle_ok? = [0, 1].include?(@occasion)
    def menu_ok? = [0, 2].include?(@occasion)
  end

  class Skill < UsableItem
    attr_accessor :mp_cost, :hit, :message1, :message2
    def initialize
      super
      @scope = 1
      @mp_cost = 0
      @hit = 100
      @message1 = ''
      @message2 = ''
    end
  end

  class Item < UsableItem
    attr_accessor :price, :consumable, :hp_recovery_rate, :hp_recovery, :mp_recovery_rate,
                  :mp_recovery, :parameter_type, :parameter_points
    def initialize
      super
      @scope = 7
      @price = 0
      @consumable = true
      @hp_recovery_rate = @hp_recovery = @mp_recovery_rate = @mp_recovery = 0
      @parameter_type = 0
      @parameter_points = 0
    end
  end

  class Weapon < BaseItem
    attr_accessor :animation_id, :price, :hit, :atk, :def, :spi, :agi, :two_handed,
                  :fast_attack, :dual_attack, :critical_bonus, :element_set, :state_set
    def initialize
      super
      @animation_id = 0
      @price = 0
      @hit = 95
      @atk = @def = @spi = @agi = 0
      @two_handed = @fast_attack = @dual_attack = @critical_bonus = false
      @element_set = []
      @state_set = []
    end
  end

  class Armor < BaseItem
    attr_accessor :kind, :price, :eva, :atk, :def, :spi, :agi, :prevent_critical,
                  :half_mp_cost, :double_exp_gain, :auto_hp_recover, :element_set, :state_set
    def initialize
      super
      @kind = 0
      @price = 0
      @eva = 0
      @atk = @def = @spi = @agi = 0
      @prevent_critical = @half_mp_cost = @double_exp_gain = @auto_hp_recover = false
      @element_set = []
      @state_set = []
    end
  end

  class Enemy
    attr_accessor :id, :name, :battler_name, :battler_hue, :maxhp, :maxmp, :atk, :def, :spi,
                  :agi, :hit, :eva, :exp, :gold, :drop_item1, :drop_item2, :levitate,
                  :has_critical, :element_ranks, :state_ranks, :actions, :note
    def initialize
      @id = 0
      @name = ''
      @battler_name = ''
      @battler_hue = 0
      @maxhp = 10
      @maxmp = 10
      @atk = @def = @spi = @agi = 10
      @hit = 95
      @eva = 5
      @exp = @gold = 0
      @drop_item1 = DropItem.new
      @drop_item2 = DropItem.new
      @levitate = false
      @has_critical = false
      @element_ranks = Table.new(1)
      @state_ranks = Table.new(1)
      @actions = [Action.new]
      @note = ''
    end

    class DropItem
      attr_accessor :kind, :item_id, :weapon_id, :armor_id, :denominator
      def initialize
        @kind = 0
        @item_id = @weapon_id = @armor_id = 1
        @denominator = 1
      end
    end

    class Action
      attr_accessor :kind, :basic, :skill_id, :condition_type, :condition_param1,
                    :condition_param2, :rating
      def initialize
        @kind = 0
        @basic = 0
        @skill_id = 1
        @condition_type = 0
        @condition_param1 = @condition_param2 = 0
        @rating = 5
      end
      def skill? = @kind == 1
    end
  end

  class Troop
    attr_accessor :id, :name, :members, :pages
    def initialize
      @id = 0
      @name = ''
      @members = []
      @pages = [Page.new]
    end

    class Member
      attr_accessor :enemy_id, :x, :y, :hidden, :immortal
      def initialize
        @enemy_id = 1
        @x = @y = 0
        @hidden = @immortal = false
      end
    end

    class Page
      attr_accessor :condition, :span, :list
      def initialize
        @condition = Condition.new
        @span = 0
        @list = [EventCommand.new]
      end

      class Condition
        attr_accessor :turn_ending, :turn_valid, :enemy_valid, :actor_valid, :switch_valid,
                      :turn_a, :turn_b, :enemy_index, :enemy_hp, :actor_id, :actor_hp, :switch_id
        def initialize
          @turn_ending = @turn_valid = @enemy_valid = @actor_valid = @switch_valid = false
          @turn_a = @turn_b = 0
          @enemy_index = 0
          @enemy_hp = 50
          @actor_id = 1
          @actor_hp = 50
          @switch_id = 1
        end
      end
    end
  end

  class State
    attr_accessor :id, :name, :icon_index, :restriction, :priority, :atk_rate, :def_rate,
                  :spi_rate, :agi_rate, :nonresistance, :offset_by_opposite, :slip_damage,
                  :reduce_hit_ratio, :battle_only, :release_by_damage, :hold_turn,
                  :auto_release_prob, :message1, :message2, :message3, :message4,
                  :element_set, :state_set, :note
    def initialize
      @id = 0
      @name = ''
      @icon_index = 0
      @restriction = 0
      @priority = 5
      @atk_rate = @def_rate = @spi_rate = @agi_rate = 100
      @nonresistance = @offset_by_opposite = @slip_damage = @reduce_hit_ratio = false
      @battle_only = true
      @release_by_damage = false
      @hold_turn = 0
      @auto_release_prob = 0
      @message1 = @message2 = @message3 = @message4 = ''
      @element_set = []
      @state_set = []
      @note = ''
    end
  end

  class Animation
    attr_accessor :id, :name, :animation1_name, :animation1_hue, :animation2_name,
                  :animation2_hue, :position, :frame_max, :frames, :timings
    def initialize
      @id = 0
      @name = ''
      @animation1_name = ''
      @animation1_hue = 0
      @animation2_name = ''
      @animation2_hue = 0
      @position = 1
      @frame_max = 1
      @frames = [Frame.new]
      @timings = []
    end

    class Frame
      attr_accessor :cell_max, :cell_data
      def initialize
        @cell_max = 0
        @cell_data = Table.new(0, 0)
      end
    end

    class Timing
      attr_accessor :frame, :se, :flash_scope, :flash_color, :flash_duration
      def initialize
        @frame = 0
        @se = SE.new('', 80)
        @flash_scope = 0
        @flash_color = Color.new(255, 255, 255, 255)
        @flash_duration = 5
      end
    end
  end

  class CommonEvent
    attr_accessor :id, :name, :trigger, :switch_id, :list
    def initialize
      @id = 0
      @name = ''
      @trigger = 0
      @switch_id = 1
      @list = [EventCommand.new]
    end
  end

  class System
    attr_accessor :game_title, :version_id, :party_members, :elements, :switches, :variables,
                  :passages, :boat, :ship, :airship, :title_bgm, :battle_bgm, :battle_end_me,
                  :gameover_me, :sounds, :test_battlers, :test_troop_id, :start_map_id,
                  :start_x, :start_y, :terms, :battler_name, :battler_hue, :edit_map_id
    def initialize
      @game_title = ''
      @version_id = 0
      @party_members = [1]
      @elements = [nil, '']
      @switches = [nil, '']
      @variables = [nil, '']
      @passages = Table.new(8192)
      @boat = Vehicle.new
      @ship = Vehicle.new
      @airship = Vehicle.new
      @title_bgm = BGM.new
      @battle_bgm = BGM.new
      @battle_end_me = ME.new
      @gameover_me = ME.new
      @sounds = Array.new(20) { SE.new }
      @test_battlers = []
      @test_troop_id = 1
      @start_map_id = 1
      @start_x = @start_y = 0
      @terms = Terms.new
      @battler_name = ''
      @battler_hue = 0
      @edit_map_id = 1
    end

    class Vehicle
      attr_accessor :character_name, :character_index, :bgm, :start_map_id, :start_x, :start_y
      def initialize
        @character_name = ''
        @character_index = 0
        @bgm = BGM.new
        @start_map_id = 0
        @start_x = @start_y = 0
      end
    end

    class Terms
      attr_accessor :level, :level_a, :hp, :hp_a, :mp, :mp_a, :atk, :def, :spi, :agi,
                    :weapon, :armor1, :armor2, :armor3, :armor4, :weapon1, :weapon2,
                    :attack, :skill, :guard, :item, :equip, :status, :save, :game_end,
                    :fight, :escape, :new_game, :continue, :shutdown, :to_title, :cancel, :gold
      def initialize
        instance_variables.each { |v| instance_variable_set(v, '') }
      end
    end

    class TestBattler
      attr_accessor :actor_id, :level, :weapon_id, :armor1_id, :armor2_id, :armor3_id, :armor4_id
      def initialize
        @actor_id = 1
        @level = 1
        @weapon_id = @armor1_id = @armor2_id = @armor3_id = @armor4_id = 0
      end
    end
  end
end
