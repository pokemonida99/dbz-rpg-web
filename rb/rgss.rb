# RGSS2 (RPG Maker VX) runtime for the browser.
# Game state lives in Ruby; pixels live in JS canvases (see js/rgss.js).
# Each Graphics.update serializes the scene graph once and hands it to JS.

require 'js'
require 'zlib'

Fixnum = Integer unless defined?(Fixnum)
Bignum = Integer unless defined?(Bignum)

RG = JS.global[:RG]

module Kernel
  def print(*a)
    s = a.map(&:to_s).join
    RG.call(:alert, s)
    nil
  end

  def msgbox(*a); print(*a); end

  def load_data(fn)
    obj = File.open(fn, 'rb') { |f| Marshal.load(f) }
    RGSSUtil.fix_enc(obj, {})
    obj
  end

  def save_data(obj, fn)
    File.open(fn, 'wb') { |f| Marshal.dump(obj, f) }
    nil
  end
end

# ruby.wasm emulates longjmp with Asyncify, and a `break`/`return` out of a block that crosses a
# C-implemented iterator leaks memory proportional to the stack depth on every jump. RGSS code does
# this constantly (`for ... break`), so the hot iterators are reimplemented in Ruby: jumps out of
# Ruby-level frames are handled inside the VM without longjmp.
class Array
  def each
    return to_enum(:each) { size } unless block_given?
    i = 0
    while i < size
      yield at(i)
      i += 1
    end
    self
  end

  def each_with_index
    return to_enum(:each_with_index) { size } unless block_given?
    i = 0
    while i < size
      yield at(i), i
      i += 1
    end
    self
  end

  def each_index
    return to_enum(:each_index) { size } unless block_given?
    i = 0
    while i < size
      yield i
      i += 1
    end
    self
  end

  def reverse_each
    return to_enum(:reverse_each) { size } unless block_given?
    i = size - 1
    while i >= 0
      yield at(i) if i < size
      i -= 1
    end
    self
  end
end

class Range
  alias_method :__rgss_c_each, :each
  def each(&blk)
    return to_enum(:each) { size } unless blk
    f = self.begin
    l = self.end
    return __rgss_c_each(&blk) unless f.is_a?(Integer) && l.is_a?(Integer)
    l -= 1 if exclude_end?
    while f <= l
      yield f
      f += 1
    end
    self
  end
end

class Integer
  def upto(l)
    return to_enum(:upto, l) unless block_given?
    i = self
    while i <= l
      yield i
      i += 1
    end
    self
  end

  def downto(l)
    return to_enum(:downto, l) unless block_given?
    i = self
    while i >= l
      yield i
      i -= 1
    end
    self
  end
end

class Hash
  def each
    return to_enum(:each) { size } unless block_given?
    ks = keys
    i = 0
    while i < ks.size
      k = ks[i]
      yield [k, self[k]]
      i += 1
    end
    self
  end
  alias_method :each_pair, :each

  def each_value
    return to_enum(:each_value) { size } unless block_given?
    values.each { |v| yield v }
    self
  end

  def each_key
    return to_enum(:each_key) { size } unless block_given?
    keys.each { |k| yield k }
    self
  end
end

# Marshal data from RGSS (Ruby 1.8) has no encoding info -> force UTF-8.
module RGSSUtil
  module_function

  def fix_enc(o, seen)
    case o
    when String
      o.force_encoding(Encoding::UTF_8) if o.encoding != Encoding::UTF_8 && !o.frozen?
    when Array
      return if seen[o.__id__]; seen[o.__id__] = true
      o.each { |e| fix_enc(e, seen) }
    when Hash
      return if seen[o.__id__]; seen[o.__id__] = true
      o.each { |k, v| fix_enc(k, seen); fix_enc(v, seen) }
    when Numeric, Symbol, NilClass, TrueClass, FalseClass, Table, Color, Tone
      # nothing
    else
      return if seen[o.__id__]; seen[o.__id__] = true
      o.instance_variables.each { |iv| fix_enc(o.instance_variable_get(iv), seen) }
    end
  end

  def b64(s) = [s].pack('m0')
  def unb64(s) = s.unpack1('m0')
end

# Event scripts are re-evaluated every frame; compiling each distinct snippet once into a method
# avoids ruby.wasm's per-eval memory growth (and is much faster).
module RGSSEvalCache
  @names = {}
  @seq = 0
  def self.method_for(klass, code)
    key = [klass, code]
    return @names[key] if @names.key?(key)
    name = :"__rgss_eval_#{@seq += 1}"
    begin
      klass.class_eval("def #{name}\n#{code}\nend", '(event script)', 0)
    rescue SyntaxError
      name = nil # e.g. class definitions inside the snippet; fall back to plain eval
    end
    @names[key] = name
  end
end

class Object
  private def rgss_eval(code)
    name = RGSSEvalCache.method_for(self.class, code)
    name ? __send__(name) : eval(code)
  end
end

# Simplified -> Traditional conversion of a whole string (phrase-aware). Used where the game splits
# text into single characters before drawing, so the phrase context isn't lost.
def rgss_s2t(str) = RG.call(:s2t, str.to_s).to_s

class RGSSError < StandardError; end
class RGSSReset < Exception; end

#--------------------------------------------------------------------------
# Value types
#--------------------------------------------------------------------------
class Rect
  attr_accessor :x, :y, :width, :height
  def initialize(x = 0, y = 0, w = 0, h = 0) = set(x, y, w, h)
  def set(x, y = nil, w = nil, h = nil)
    if x.is_a?(Rect)
      @x, @y, @width, @height = x.x, x.y, x.width, x.height
    else
      @x, @y, @width, @height = x, y, w, h
    end
    self
  end
  def empty = set(0, 0, 0, 0)
  def ==(o) = o.is_a?(Rect) && @x == o.x && @y == o.y && @width == o.width && @height == o.height
  def to_s = "(#{@x}, #{@y}, #{@width}, #{@height})"
  def _dump(_l) = [@x, @y, @width, @height].pack('l<4')
  def self._load(s) = new(*s.unpack('l<4'))
end

class Color
  attr_reader :red, :green, :blue, :alpha
  def initialize(r = 0, g = 0, b = 0, a = 255) = set(r, g, b, a)
  def set(r, g = nil, b = nil, a = 255)
    if r.is_a?(Color)
      @red, @green, @blue, @alpha = r.red, r.green, r.blue, r.alpha
    else
      self.red = r; self.green = g; self.blue = b; self.alpha = a
    end
    self
  end
  def red=(v); @red = v.to_f.clamp(0.0, 255.0); end
  def green=(v); @green = v.to_f.clamp(0.0, 255.0); end
  def blue=(v); @blue = v.to_f.clamp(0.0, 255.0); end
  def alpha=(v); @alpha = v.to_f.clamp(0.0, 255.0); end
  def ==(o) = o.is_a?(Color) && @red == o.red && @green == o.green && @blue == o.blue && @alpha == o.alpha
  def to_s = "(#{@red}, #{@green}, #{@blue}, #{@alpha})"
  def _dump(_l) = [@red, @green, @blue, @alpha].pack('E4')
  def self._load(s) = new(*s.unpack('E4'))
end

class Tone
  attr_reader :red, :green, :blue, :gray
  def initialize(r = 0, g = 0, b = 0, gr = 0) = set(r, g, b, gr)
  def set(r, g = nil, b = nil, gr = 0)
    if r.is_a?(Tone)
      @red, @green, @blue, @gray = r.red, r.green, r.blue, r.gray
    else
      self.red = r; self.green = g; self.blue = b; self.gray = gr
    end
    self
  end
  def red=(v); @red = v.to_f.clamp(-255.0, 255.0); end
  def green=(v); @green = v.to_f.clamp(-255.0, 255.0); end
  def blue=(v); @blue = v.to_f.clamp(-255.0, 255.0); end
  def gray=(v); @gray = v.to_f.clamp(0.0, 255.0); end
  def ==(o) = o.is_a?(Tone) && @red == o.red && @green == o.green && @blue == o.blue && @gray == o.gray
  def to_s = "(#{@red}, #{@green}, #{@blue}, #{@gray})"
  def _dump(_l) = [@red, @green, @blue, @gray].pack('E4')
  def self._load(s) = new(*s.unpack('E4'))
end

class Table
  attr_reader :xsize, :ysize, :zsize, :data
  attr_accessor :version
  def initialize(x, y = 1, z = 1)
    @dim = 1 + (y > 1 ? 1 : 0) + (z > 1 ? 1 : 0)
    @xsize, @ysize, @zsize = x, y, z
    @data = Array.new(x * y * z, 0)
    @version = 0
  end
  def [](x, y = 0, z = 0)
    return nil if x < 0 || y < 0 || z < 0 || x >= @xsize || y >= @ysize || z >= @zsize
    @data[x + (y + z * @ysize) * @xsize]
  end
  def []=(*a)
    v = a.pop
    x, y, z = a[0], a[1] || 0, a[2] || 0
    return if x < 0 || y < 0 || z < 0 || x >= @xsize || y >= @ysize || z >= @zsize
    v = v.to_i
    v = ((v + 32768) % 65536) - 32768
    @data[x + (y + z * @ysize) * @xsize] = v
    @version += 1
  end
  def resize(x, y = 1, z = 1)
    nd = Array.new(x * y * z, 0)
    [z, @zsize].min.times do |k|
      [y, @ysize].min.times do |j|
        [x, @xsize].min.times { |i| nd[i + (j + k * y) * x] = self[i, j, k] }
      end
    end
    @dim = 1 + (y > 1 ? 1 : 0) + (z > 1 ? 1 : 0)
    @xsize, @ysize, @zsize, @data = x, y, z, nd
    @version += 1
  end
  def _dump(_l) = [@dim, @xsize, @ysize, @zsize, @data.size].pack('l<5') + @data.pack('s<*')
  def self._load(s)
    dim, x, y, z, n = s.unpack('l<5')
    t = allocate
    t.instance_variable_set(:@dim, dim)
    t.instance_variable_set(:@xsize, x)
    t.instance_variable_set(:@ysize, y)
    t.instance_variable_set(:@zsize, z)
    t.instance_variable_set(:@data, s.byteslice(20, n * 2).unpack('s<*'))
    t.instance_variable_set(:@version, 0)
    t
  end
  def to_b64 = RGSSUtil.b64(@data.pack('s<*'))
end

class Font
  class << self
    attr_accessor :default_name, :default_size, :default_bold, :default_italic,
                  :default_shadow, :default_outline, :default_color, :default_out_color
    def exist?(_name) = true
  end
  self.default_name = 'UmePlus Gothic'
  self.default_size = 20
  self.default_bold = false
  self.default_italic = false
  self.default_shadow = true
  self.default_outline = false
  self.default_color = Color.new(255, 255, 255, 255)
  self.default_out_color = Color.new(0, 0, 0, 128)

  attr_accessor :name, :size, :bold, :italic, :shadow, :outline
  attr_reader :color, :out_color
  def initialize(name = Font.default_name, size = Font.default_size)
    @name = name.is_a?(Array) ? name.dup : name
    @size = size
    @bold = Font.default_bold
    @italic = Font.default_italic
    @shadow = Font.default_shadow
    @outline = Font.default_outline
    @color = Color.new.set(Font.default_color)
    @out_color = Color.new.set(Font.default_out_color)
  end
  def color=(c); (@color = c.is_a?(Color) ? c : Color.new(*c)); end
  def out_color=(c); (@out_color = c); end
  def initialize_copy(o)
    super
    @color = o.color.dup
    @out_color = o.out_color.dup
  end
  def js_name = (@name.is_a?(Array) ? @name.join(',') : @name.to_s)
end

#--------------------------------------------------------------------------
# Bitmap
#--------------------------------------------------------------------------
class Bitmap
  attr_reader :id, :width, :height
  attr_accessor :font

  def initialize(a, b = nil)
    if b.nil?
      path = a.to_s
      id = RG.call(:bmpLoad, path).to_i
      raise Errno::ENOENT, path if id < 0
      @id = id
    else
      @id = RG.call(:bmpNew, a.to_i, b.to_i).to_i
    end
    sz = RG.call(:bmpSize, @id).to_s.split(',')
    @width, @height = sz[0].to_i, sz[1].to_i
    @font = Font.new
    @disposed = false
  end

  def initialize_copy(o)
    @id = RG.call(:bmpClone, o.id).to_i
    @width, @height = o.width, o.height
    @font = o.font.dup
    @disposed = false
  end

  def dispose
    return if @disposed
    RG.call(:bmpFree, @id)
    @disposed = true
  end
  def disposed? = @disposed
  def rect = Rect.new(0, 0, @width, @height)

  def blt(x, y, src, r, opacity = 255)
    return if src.nil? || src.disposed?
    RG.call(:blt, @id, x, y, src.id, r.x, r.y, r.width, r.height, opacity)
  end

  def stretch_blt(dr, src, sr, opacity = 255)
    return if src.nil? || src.disposed?
    RG.call(:sblt, @id, dr.x, dr.y, dr.width, dr.height, src.id, sr.x, sr.y, sr.width, sr.height, opacity)
  end

  def fill_rect(*a)
    if a[0].is_a?(Rect)
      r, c = a
      x, y, w, h = r.x, r.y, r.width, r.height
    else
      x, y, w, h, c = a
    end
    RG.call(:fill, @id, x, y, w, h, c.red, c.green, c.blue, c.alpha)
  end

  def gradient_fill_rect(*a)
    if a[0].is_a?(Rect)
      r, c1, c2, v = a
      x, y, w, h = r.x, r.y, r.width, r.height
    else
      x, y, w, h, c1, c2, v = a
    end
    RG.call(:gfill, @id, x, y, w, h, c1.red, c1.green, c1.blue, c1.alpha,
            c2.red, c2.green, c2.blue, c2.alpha, v ? 1 : 0)
  end

  def clear = RG.call(:clearRect, @id, 0, 0, @width, @height)

  def clear_rect(*a)
    if a[0].is_a?(Rect)
      r = a[0]
      RG.call(:clearRect, @id, r.x, r.y, r.width, r.height)
    else
      RG.call(:clearRect, @id, *a[0, 4])
    end
  end

  def get_pixel(x, y)
    v = RG.call(:getPixel, @id, x, y).to_s.split(',')
    Color.new(v[0].to_i, v[1].to_i, v[2].to_i, v[3].to_i)
  end

  def set_pixel(x, y, c) = RG.call(:fill, @id, x, y, 1, 1, c.red, c.green, c.blue, c.alpha, 1)
  def hue_change(h) = RG.call(:hue, @id, h)
  def blur = RG.call(:blur, @id, 1)
  def radial_blur(_angle, _division) = RG.call(:blur, @id, 3)

  def draw_text(*a)
    if a[0].is_a?(Rect)
      r, str, align = a
      x, y, w, h = r.x, r.y, r.width, r.height
    else
      x, y, w, h, str, align = a
    end
    str = str.to_s
    return if str.empty?
    f = @font
    c = f.color
    oc = f.out_color
    RG.call(:text, @id, x, y, w, h, str, align || 0, f.js_name, f.size, f.bold ? 1 : 0, f.italic ? 1 : 0,
            f.shadow ? 1 : 0, f.outline ? 1 : 0, c.red, c.green, c.blue, c.alpha,
            oc.red, oc.green, oc.blue, oc.alpha)
  end

  def text_size(str)
    f = @font
    w = RG.call(:textWidth, str.to_s, f.js_name, f.size, f.bold ? 1 : 0, f.italic ? 1 : 0).to_i
    Rect.new(0, 0, w, f.size)
  end

  # --- hn_rg_bitmap.dll replacements ---
  def get_pixel_data_bgra = RGSSUtil.unb64(RG.call(:getData, @id).to_s)
  def set_pixel_data_bgra(d) = RG.call(:setData, @id, RGSSUtil.b64(d))
end

#--------------------------------------------------------------------------
# Scene graph
#--------------------------------------------------------------------------
module RGSSNode
  def node_init(viewport)
    @viewport = viewport
    @z = 0
    @visible = true
    @disposed = false
    @node_seq = Graphics.next_seq
    (viewport ? viewport.children : Graphics.roots) << self
  end

  def dispose
    return if @disposed
    @disposed = true
    (@viewport ? @viewport.children : Graphics.roots).delete(self)
  end
  def disposed? = @disposed
  attr_reader :viewport, :node_seq
  attr_accessor :visible
  attr_reader :z
  def z=(v); @z = v.to_i; end
  def sort_key = [@z, @node_seq]
end

module RGSSFlash
  def flash(color, duration)
    @flash_color = color ? color.dup : nil
    @flash_hide = color.nil?
    @flash_duration = duration
    @flash_count = duration
  end

  def flash_update
    return unless @flash_count && @flash_count > 0
    @flash_count -= 1
  end

  # current flash rgba (alpha scaled by remaining time)
  def flash_values
    return [0, 0, 0, 0] unless @flash_count && @flash_count > 0 && @flash_color
    a = @flash_color.alpha * @flash_count / @flash_duration.to_f
    [@flash_color.red, @flash_color.green, @flash_color.blue, a]
  end

  def flash_hidden? = @flash_hide && @flash_count && @flash_count > 0
end

class Viewport
  include RGSSNode
  include RGSSFlash
  attr_accessor :rect, :ox, :oy, :color, :tone
  attr_reader :children

  def initialize(*a)
    @children = []
    @rect = a.empty? ? Rect.new(0, 0, Graphics.width, Graphics.height) : (a[0].is_a?(Rect) ? a[0].dup : Rect.new(*a))
    @ox = 0
    @oy = 0
    @color = Color.new(0, 0, 0, 0)
    @tone = Tone.new(0, 0, 0, 0)
    node_init(nil)
  end

  def update = flash_update

  def emit(out)
    return if !@visible || flash_hidden?
    fl = flash_values
    out << 5 << @rect.x << @rect.y << @rect.width << @rect.height << @ox << @oy <<
      @color.red << @color.green << @color.blue << @color.alpha <<
      @tone.red << @tone.green << @tone.blue << @tone.gray << fl[0] << fl[1] << fl[2] << fl[3]
    Graphics.emit_list(@children, out)
    out << 6
  end
end

class Sprite
  include RGSSNode
  include RGSSFlash
  attr_accessor :bitmap, :src_rect, :x, :y, :ox, :oy, :zoom_x, :zoom_y, :angle,
                :mirror, :bush_depth, :opacity, :blend_type, :color, :tone,
                :wave_amp, :wave_length, :wave_speed, :wave_phase, :bush_opacity

  def initialize(viewport = nil)
    @bitmap = nil
    @src_rect = Rect.new(0, 0, 0, 0)
    @x = @y = @ox = @oy = 0
    @zoom_x = @zoom_y = 1.0
    @angle = 0
    @mirror = false
    @bush_depth = 0
    @bush_opacity = 128
    @opacity = 255
    @blend_type = 0
    @color = Color.new(0, 0, 0, 0)
    @tone = Tone.new(0, 0, 0, 0)
    @wave_amp = 0
    @wave_length = 180
    @wave_speed = 360
    @wave_phase = 0.0
    node_init(viewport)
  end

  def bitmap=(b)
    @bitmap = b
    @src_rect.set(0, 0, b.width, b.height) if b && !b.disposed?
  end

  def opacity=(v); @opacity = v.to_i.clamp(0, 255); end
  def width = @src_rect.width
  def height = @src_rect.height

  def update
    flash_update
    @wave_phase += @wave_speed / 180.0 if @wave_amp != 0
  end

  def emit(out)
    b = @bitmap
    return if !@visible || b.nil? || b.disposed? || @opacity <= 0 || flash_hidden?
    fl = flash_values
    out << 1 << b.id << @x << @y << @ox << @oy << @src_rect.x << @src_rect.y << @src_rect.width << @src_rect.height <<
      @zoom_x << @zoom_y << @angle << (@mirror ? 1 : 0) << @opacity << @blend_type << @bush_depth <<
      @color.red << @color.green << @color.blue << @color.alpha <<
      @tone.red << @tone.green << @tone.blue << @tone.gray <<
      fl[0] << fl[1] << fl[2] << fl[3] << @wave_amp << @wave_length << @wave_phase
  end
end

class Plane
  include RGSSNode
  attr_accessor :bitmap, :ox, :oy, :zoom_x, :zoom_y, :opacity, :blend_type, :color, :tone

  def initialize(viewport = nil)
    @bitmap = nil
    @ox = @oy = 0
    @zoom_x = @zoom_y = 1.0
    @opacity = 255
    @blend_type = 0
    @color = Color.new(0, 0, 0, 0)
    @tone = Tone.new(0, 0, 0, 0)
    node_init(viewport)
  end

  def emit(out)
    b = @bitmap
    return if !@visible || b.nil? || b.disposed? || @opacity <= 0
    out << 2 << b.id << @ox << @oy << @zoom_x << @zoom_y << @opacity << @blend_type <<
      @color.red << @color.green << @color.blue << @color.alpha <<
      @tone.red << @tone.green << @tone.blue << @tone.gray
  end
end

class Window
  include RGSSNode
  attr_accessor :windowskin, :contents, :cursor_rect, :active, :pause,
                :x, :y, :width, :height, :ox, :oy, :back_opacity, :contents_opacity
  attr_reader :opacity, :openness

  def initialize(viewport = nil)
    @windowskin = nil
    @contents = Bitmap.new(1, 1)
    @cursor_rect = Rect.new(0, 0, 0, 0)
    @active = true
    @pause = false
    @x = @y = @width = @height = @ox = @oy = 0
    @opacity = 255
    @back_opacity = 200
    @contents_opacity = 255
    @openness = 255
    @anim = 0
    node_init(viewport)
  end

  def opacity=(v); @opacity = v.to_i.clamp(0, 255); end
  def openness=(v); @openness = v.to_i.clamp(0, 255); end
  def update = (@anim += 1)
  def contents_dispose_check = (@contents && @contents.disposed?)

  def emit(out)
    return if !@visible
    sk = (@windowskin && !@windowskin.disposed?) ? @windowskin.id : -1
    ct = (@contents && !@contents.disposed?) ? @contents.id : -1
    out << 3 << sk << ct << @x << @y << @width << @height << @ox << @oy << @opacity << @back_opacity <<
      @contents_opacity << @openness << @cursor_rect.x << @cursor_rect.y << @cursor_rect.width <<
      @cursor_rect.height << (@active ? 1 : 0) << (@pause ? 1 : 0) << @anim
  end
end

class Tilemap
  attr_reader :bitmaps, :viewport
  attr_accessor :map_data, :flash_data, :passages, :visible, :ox, :oy

  # The tilemap is drawn as two scene nodes: ground (z=0) and upper (z=200).
  class Layer
    include RGSSNode
    def initialize(tm, upper, vp)
      @tm = tm
      @upper = upper
      node_init(vp)
      @z = upper ? 200 : 0
    end
    def emit(out) = @tm.emit_layer(out, @upper)
  end

  @@seq = 0

  def initialize(viewport = nil)
    @viewport = viewport
    @bitmaps = Array.new(9)
    @map_data = nil
    @flash_data = nil
    @passages = nil
    @visible = true
    @ox = @oy = 0
    @disposed = false
    @tid = (@@seq += 1)
    @sent = {}
    @layers = [Layer.new(self, false, viewport), Layer.new(self, true, viewport)]
  end

  def dispose
    return if @disposed
    @layers.each(&:dispose)
    RG.call(:tmFree, @tid)
    @disposed = true
  end
  def disposed? = @disposed
  def update; end

  def sync
    md = @map_data
    if md && (@sent[:md] != md.__id__ || @sent[:mdv] != md.version)
      RG.call(:tmMap, @tid, md.xsize, md.ysize, md.zsize, md.to_b64)
      @sent[:md] = md.__id__
      @sent[:mdv] = md.version
    end
    ps = @passages
    if ps && (@sent[:ps] != ps.__id__ || @sent[:psv] != ps.version)
      RG.call(:tmPass, @tid, ps.to_b64)
      @sent[:ps] = ps.__id__
      @sent[:psv] = ps.version
    end
    ids = @bitmaps.map { |b| (b && !b.disposed?) ? b.id : -1 }.join(',')
    if @sent[:bm] != ids
      RG.call(:tmBitmaps, @tid, ids)
      @sent[:bm] = ids
    end
  end

  def emit_layer(out, upper)
    return if !@visible || @map_data.nil?
    sync unless upper
    out << 4 << @tid << (upper ? 1 : 0) << @ox << @oy << Graphics.frame_count
  end
end

#--------------------------------------------------------------------------
# Graphics
#--------------------------------------------------------------------------
module Graphics
  @frame_count = 0
  @frame_rate = 60
  @brightness = 255
  @width = 544
  @height = 416
  @roots = []
  @seq = 0

  class << self
    attr_accessor :frame_count
    attr_reader :frame_rate, :brightness, :width, :height, :roots

    def next_seq = (@seq += 1)
    def frame_rate=(v); @frame_rate = v.to_i.clamp(10, 120); end
    def brightness=(v); @brightness = v.to_i.clamp(0, 255); end

    def emit_list(list, out)
      list.sort_by(&:sort_key).each { |n| n.emit(out) }
    end

    def draw_list
      out = []
      emit_list(@roots, out)
      out.join(',')
    end

    # true while a battle scene runs (battles can play at double speed)
    def battle_scene?
      return @battle_flag if @battle_scene.equal?($scene)
      @battle_scene = $scene
      @battle_flag = $scene.class.name.to_s.start_with?('Scene_Db_Battle') && $scene.class.name != 'Scene_Db_Battle_arena'
    end

    def update
      @frame_count += 1
      r = RG.call(:frame, @frame_rate, @brightness, battle_scene? ? 1 : 0).to_i
      raise RGSSReset if r == 2
      RG.call(:render, draw_list) if r & 1 == 1
      Input.poll_reset
      if defined?(RGSSQuick)
        RGSSQuick.handle if r & 4 == 4
        RGSSQuick.tick
      end
      (GC.enable; GC.start; GC.disable) if $RGSS_MANUAL_GC && @frame_count % $RGSS_MANUAL_GC == 0
      if $RGSS_DEBUG && (cmd = RG.call(:pollCmd).to_s) != ''
        res = begin
          TOPLEVEL_BINDING.eval(cmd).inspect
        rescue Exception => e
          "#{e.class}: #{e.message}"
        end
        RG.call(:dbg, "repl> #{res}")
      end
      if @frame_count % 600 == 0 && $RGSS_DEBUG
        st = GC.stat
        prof = defined?(RGSSProf) ? RGSSProf.acc.map { |k, v| "#{k}=#{v >> 10}K" }.join(' ') : ''
        RG.call(:dbg, "f=#{@frame_count} gc=#{st[:count]} live=#{st[:heap_live_slots]} scene=#{$scene.class} map=#{$game_map && $game_map.map_id} #{prof}")
      end
    end

    def wait(n) = n.times { update }

    def fadeout(d)
      b = @brightness
      d.times { |i| self.brightness = b - b * (i + 1) / d; update }
    end

    def fadein(d)
      d.times { |i| self.brightness = 255 * (i + 1) / d; update }
    end

    def freeze
      RG.call(:render, draw_list)
      RG.call(:freeze)
    end

    def transition(d = 10, fn = '', vague = 40)
      d = d.to_i
      mask = -1
      if fn && !fn.to_s.empty?
        begin
          mask = Bitmap.new(fn).id
        rescue Errno::ENOENT
          mask = -1
        end
      end
      RG.call(:transStart, d, mask, vague.to_i)
      if d <= 0
        RG.call(:render, draw_list)
      else
        d.times do |i|
          RG.call(:transStep, (i + 1).to_f / d)
          update
        end
      end
      RG.call(:transEnd)
      RG.call(:bmpFree, mask) if mask >= 0
    end

    def snap_to_bitmap
      b = Bitmap.new(@width, @height)
      RG.call(:snap, draw_list, b.id)
      b
    end

    def frame_reset; end

    # drops everything on screen; used when a quick load / reset abandons the running scene
    def reset_scene_graph
      @roots.dup.each { |n| n.dispose rescue nil }
      @brightness = 255
      RG.call(:transEnd)
    end

    def resize_screen(w, h)
      @width = w
      @height = h
      RG.call(:resize, w, h)
    end
  end
end

#--------------------------------------------------------------------------
# Input
#--------------------------------------------------------------------------
module Input
  DOWN = 2; LEFT = 4; RIGHT = 6; UP = 8
  A = 11; B = 12; C = 13; X = 14; Y = 15; Z = 16; L = 17; R = 18
  SHIFT = 21; CTRL = 22; ALT = 23
  F5 = 25; F6 = 26; F7 = 27; F8 = 28; F9 = 29
  KEYS = [DOWN, LEFT, RIGHT, UP, A, B, C, X, Y, Z, L, R, SHIFT, CTRL, ALT, F5, F6, F7, F8, F9].freeze

  @held = Hash.new(0)

  class << self
    def poll_reset; end

    def update
      s = RG.call(:inputState).to_s
      KEYS.each_with_index do |k, i|
        if s[i] == '1'
          @held[k] += 1
        else
          @held[k] = 0
        end
      end
    end

    def press?(k) = @held[k] > 0
    def trigger?(k) = @held[k] == 1

    def repeat?(k)
      t = @held[k]
      t == 1 || (t >= 24 && (t - 24) % 6 == 0)
    end

    def dir4
      return 2 if press?(DOWN)
      return 4 if press?(LEFT)
      return 6 if press?(RIGHT)
      return 8 if press?(UP)
      0
    end

    def dir8
      d, l, r, u = press?(DOWN), press?(LEFT), press?(RIGHT), press?(UP)
      return 1 if d && l
      return 3 if d && r
      return 7 if u && l
      return 9 if u && r
      dir4
    end
  end
end

#--------------------------------------------------------------------------
# Audio
#--------------------------------------------------------------------------
module Audio
  class << self
    def bgm_play(fn, vol = 100, pitch = 100) = RG.call(:audioCall, 'bgm', 'play', fn.to_s, vol, pitch)
    def bgm_stop = RG.call(:audioCall, 'bgm', 'stop', '', 0, 0)
    def bgm_fade(t) = RG.call(:audioCall, 'bgm', 'fade', '', t, 0)
    def bgs_play(fn, vol = 80, pitch = 100) = RG.call(:audioCall, 'bgs', 'play', fn.to_s, vol, pitch)
    def bgs_stop = RG.call(:audioCall, 'bgs', 'stop', '', 0, 0)
    def bgs_fade(t) = RG.call(:audioCall, 'bgs', 'fade', '', t, 0)
    def me_play(fn, vol = 100, pitch = 100) = RG.call(:audioCall, 'me', 'play', fn.to_s, vol, pitch)
    def me_stop = RG.call(:audioCall, 'me', 'stop', '', 0, 0)
    def me_fade(t) = RG.call(:audioCall, 'me', 'fade', '', t, 0)
    def se_play(fn, vol = 80, pitch = 100) = RG.call(:audioCall, 'se', 'play', fn.to_s, vol, pitch)
    def se_stop = RG.call(:audioCall, 'se', 'stop', '', 0, 0)
  end
end

#--------------------------------------------------------------------------
# Windows API stand-ins (the game's non-Windows code paths are used)
#--------------------------------------------------------------------------
class Win32API
  def initialize(*a) = (@a = a)
  def call(*_a) = 0
  alias Call call
end
