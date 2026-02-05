#feature-id    SkynetWorkflow : Skynet Observatory > Batch Post Processing

#include <pjsr/Sizer.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdDialogCode.jsh>
#include <pjsr/DataType.jsh>
#include <pjsr/ColorSpace.jsh>
#include <pjsr/SectionBar.jsh>

#define DEFAULT_AUTOSTRETCH_SCLIP  -2.80
#define DEFAULT_AUTOSTRETCH_TBGND   0.25
#define DEFAULT_AUTOSTRETCH_CLINK   true

var __progress = null;
var __runStartMS = 0;

var __sbppPrereqOk = null;
var __sbppPrereqDetected = [];



function sbppValidatePrerequisites()
{
   var missing = [];
   var detected = [];

   function hasProcess( ctorName )
   {
      // PixInsight's JS engine may not define globalThis. Use the global object via non-strict 'this'.
      var G = null;
      try { G = (function(){ return this; })(); } catch ( __e0 ) { G = null; }
      try
      {
         return ( G && typeof G[ ctorName ] === "function" );
      }
      catch ( __e )
      {
         return false;
      }
   }

   function check( name, label )
   {
      if ( hasProcess( name ) )
         detected.push( label );
      else
         missing.push( label );
   }

   check( "GraXpert", "GraXpert" );
   check( "BlurXTerminator", "BXT" );
   check( "NoiseXTerminator", "NXT" );
   check( "StarXTerminator", "SXT" );

   __sbppPrereqDetected = detected.slice( 0 );
   __sbppPrereqOk = (missing.length === 0);

   if ( !__sbppPrereqOk )
   {
      var msg =
         "SBPP prerequisite check failed.\\n\\n" +
         "The following required components are not installed:\\n\\n" +
         "• " + missing.join( "\\n• " ) + "\\n\\n" +
         "SBPP relies on these modules and will not function without them.\\n\\n" +
         "Install the missing components and restart PixInsight.";




      try
      {
         new MessageBox( msg, "SBPP – Missing Dependencies", StdIcon_Warning, StdButton_Ok ).execute();
      }
      catch ( __e )
      {
         try { Console.warningln( "[SBPP] Missing prerequisites: " + missing.join( ", " ) ); } catch ( __e2 ) {}
      }

      return false;
   }

   return true;
}



function pumpEvents()
{
   for ( var i = 0; i < 5; ++i )
   {
      try { if ( typeof processEvents === "function" ) processEvents(); } catch ( __e ) {}
   }
}

/*
 * findBackground
 * Finds a "background-like" region in a clean, flat, starless image.
 * Returns the top-left coordinates of the best region using a robust score (median + k*MAD).
 *
 * Params:
 *   imageIdentifier (string) : view id
 *   regionWidth (int)        : ROI width in pixels
 *   regionHeight (int)       : ROI height in pixels
 *
 * Returns:
 *   { left: int, top: int }
 */
function findBackground( imageIdentifier, regionWidth, regionHeight )
{
   var view = View.viewById( imageIdentifier );
   if ( view === null )
      throw new Error( "findBackground: view not found: " + imageIdentifier );

   var img = view.image;
   var W = img.width;
   var H = img.height;

   if ( W < regionWidth || H < regionHeight )
      throw new Error( "findBackground: region larger than image." );

   // Tunables (internal)
   var marginFrac = 0.08; // ignore borders
   var step = Math.max( 25, Math.round( Math.min( regionWidth, regionHeight ) ) ); // coarse grid
   var stride = 2; // subsample inside ROI for speed (2 => 25x25 samples in a 50x50 ROI)

   var mx = Math.round( W * marginFrac );
   var my = Math.round( H * marginFrac );

   var x0 = mx;
   var y0 = my;
   var x1 = W - mx - regionWidth;
   var y1 = H - my - regionHeight;

   if ( x1 <= x0 || y1 <= y0 )
   {
      x0 = 0;
      y0 = 0;
      x1 = W - regionWidth;
      y1 = H - regionHeight;
   }

   function medianOfArray( a )
   {
      var b = a.slice( 0 );
      b.sort( function( p, q ) { return p - q; } );
      var n = b.length;
      if ( n < 1 ) return 0;
      var mid = Math.floor( n / 2 );
      return ( n & 1 ) ? b[mid] : 0.5*( b[mid-1] + b[mid] );
   }

   function madOfArray( a, med )
   {
      var d = new Array( a.length );
      for ( var i = 0; i < a.length; ++i )
         d[i] = Math.abs( a[i] - med );
      return medianOfArray( d );
   }

   function roiSamples( x, y, ww, hh )
   {
      var r = new Rect( x, y, x + ww, y + hh );

      // Pull channel 0 samples (starless + clean => good enough; fast).
      // getSamples fills the array with ww*hh values in row-major order.
      var raw = new Array( ww*hh );
      img.getSamples( raw, r, 0 );

      if ( stride <= 1 ) return raw;

      // Subsample to reduce work (every stride pixels in x and y)
      var out = [];
      for ( var yy = 0; yy < hh; yy += stride )
      {
         var rowBase = yy * ww;
         for ( var xx = 0; xx < ww; xx += stride )
            out.push( raw[rowBase + xx] );
      }
      return out;
   }

   var bestScore = 1e30;
   var bestX = x0;
   var bestY = y0;

   var k = 1.5; // structure penalty weight

   for ( var y = y0; y <= y1; y += step )
      for ( var x = x0; x <= x1; x += step )
      {
         var s = roiSamples( x, y, regionWidth, regionHeight );
         var med = medianOfArray( s );
         var mad = madOfArray( s, med );

         var score = med + k * mad;

         if ( score < bestScore )
         {
            bestScore = score;
            bestX = x;
            bestY = y;
         }
      }

   return { left: bestX, top: bestY };
}



function pauseMs( ms )
{
   var t0 = (new Date).getTime();
   while ( (new Date).getTime() - t0 < ms )
      pumpEvents();
}



function setLabelText( label, text )
{
   try { if ( label ) label.text = text; } catch ( __e ) {}
}


var SBPP_HELP_TEXT =
"Skynet Batch Post Processing (SBPP)\n\n" +
"This script is a pragmatic, repeatable linear workflow for master channels. The goal is not to create a final, competition grade image in one click. The goal is to get you to a clean, well conditioned, color calibrated starting point (plus a few optional boosts) with consistent naming and minimal UI babysitting.\n\n" +
"How to use it\n" +
"1) Select Master Files\n" +
"   Pick your masters. The script will detect channels from filenames and load them into PixInsight.\n" +
"   It renames views to canonical ids so later steps are deterministic:\n" +
"   Narrowband: Ha, Sii, Oiii\n" +
"   Broadband: R, G, B (and sometimes L when you add it later)\n\n" +
"2) Background Extraction (GraXpert)\n" +
"   Removes large scale gradients and sky glow early, while the data is still linear. This avoids baking gradients into later normalization and color decisions.\n\n" +
"3) Reference selection (statistics driven)\n" +
"   For LinearFit you need a reference channel. SBPP can pick the lowest, medium, or highest signal based on Delta (Mean minus Median). Delta is a simple, robust proxy for signal strength that tends to track nebulosity without being too easily hijacked by stars or background offsets.\n\n" +
"4) LinearFit (to the chosen reference)\n" +
"   Brings channels onto a common intensity scale. This makes channel combination behave like physics instead of like vibes.\n" +
"   SBPP runs LinearFit on the working images (the _g set) and keeps the reference stable.\n\n" +
"5) Combination (palette plus method)\n" +
"   Choose a palette and a method:\n" +
"   ChannelCombination: fast, direct mapping.\n" +
"   PixelMath: lets you mix and weight channels. The palette still defines what goes to R, G, B. The expression boxes are rearranged when you change palette, without overwriting your custom formulas.\n" +
"   Palettes:\n" +
"   SHO: Sii to R, Ha to G, Oiii to B\n" +
"   HSO: Ha to R, Sii to G, Oiii to B\n" +
"   HOO: Ha to R, Oiii to G, Oiii to B (classic HOO)\n\n" +
"6) SPCC (Spectrophotometric Color Calibration)\n" +
"   Color calibrates the combined image in a repeatable way. This is a sanity anchor before you start doing artistic things.\n\n" +
"Optional enhancement steps (linear unless noted)\n" +
"7) NoiseXTerminator (linear)\n" +
"   A light denoise while the data is linear. Useful for tightening background without creating crunchy artifacts.\n\n" +
"8) BlurXTerminator\n" +
"   Correct Only mode is used earlier in the pipeline to clean up PSF blur without turning everything into plastic.\n" +
"   Full sharpening is available later if you choose.\n\n" +
"9) StarXTerminator\n" +
"   Separates stars and starless in linear. This is optional but enables cleaner stretching and contrast work.\n\n" +
"10) Stretch (nonlinear)\n" +
"    Uses a controlled stretch (parameters in the UI). The script keeps it conservative so you do not annihilate faint signal.\n\n" +
"11) Extra nonlinear tools\n" +
"    A couple of optional knobs live here for convenience. Use them sparingly. Your taste is still required.\n\n" +
"Design notes\n" +
"    (a) The script favors deterministic view ids and explicit rename steps. That is boring, and boring is reliable.\n" +
"    (b) Steps are ordered to prevent downstream tools from being poisoned by gradients or mismatched channel scales.\n" +
"    (c) The close button is guarded while the workflow runs because PixInsight does not love being interrupted mid execution.\n\n" +
"Tip\n" +
"    Treat SBPP as a launch ramp. After it finishes, do your usual masks, contrast shaping, star handling, and final color taste adjustments. SBPP gets you to the point where those decisions are about aesthetics, not about fixing avoidable technical debt.";

function sbppShowHelpDialog()
{
   var helpDlg = new Dialog;
   helpDlg.windowTitle = "SBPP Help";
   helpDlg.ok_Button = new PushButton( helpDlg );
   helpDlg.ok_Button.text = "Close";
   helpDlg.ok_Button.onClick = function() { helpDlg.ok(); };

   var tb = new TextBox( helpDlg );
   tb.readOnly = true;
   tb.wordWrapping = true;
   tb.setScaledMinSize( 700, 520 );
   tb.text = SBPP_HELP_TEXT;

   var s = new VerticalSizer;
   s.margin = 10;
   s.spacing = 8;
   s.add( tb, 100 );
   s.add( helpDlg.ok_Button );
   helpDlg.sizer = s;

   helpDlg.execute();
}



function __safeStat( s, propNames, fallback )
{
   for ( var i = 0; i < propNames.length; ++i )
   {
      var p = propNames[i];
      try
      {
         var v = s[p];
         if ( v !== undefined && v !== null && isFinite( v ) )
            return v;
      }
      catch ( __e ) {}
   }
   return fallback;
}

function getRobustViewStats( view )
{
   var st = {};
   if ( view == null || view.isNull )
      return st;

   var S = new ImageStatistics( view.image );

   st.mean   = __safeStat( S, [ "mean" ], 0 );
   st.median = __safeStat( S, [ "median" ], 0 );

   st.stdDev = __safeStat( S, [ "standardDeviation", "stdDev", "sigma" ], 0 );

   var mad = __safeStat( S, [ "MAD", "mad" ], NaN );
   st.mad = isFinite( mad ) ? mad : NaN;
   st.madSigma = isFinite( st.mad ) ? (1.4826 * st.mad) : st.stdDev;

   st.strength = 0.80 * st.madSigma + 0.20 * st.stdDev;

   return st;
}

function __clamp( x, a, b )
{
   return Math.max( a, Math.min( b, x ) );
}

function __fmt( x )
{
   return format( "%.3f", x );
}

function __normalizeModeLabel( modeLabel )
{
   var s = (modeLabel || "").toString().trim();
   var u = s.toUpperCase();
   if ( u.indexOf( "SHO" ) === 0 ) return "SHO";
   if ( u.indexOf( "RGB" ) === 0 ) return "RGB";
   if ( u.indexOf( "SHO" ) >= 0 ) return "SHO";
   return "RGB";
}


function __paletteTextSafe( dlg )
{
   try
   {
      if ( dlg && dlg.mode === "RGB" )
         return "RGB";
      if ( dlg && dlg.palette_Combo )
         return String( dlg.palette_Combo.itemText( dlg.palette_Combo.currentItem ) || "SHO" );
   }
   catch ( __e ) {}
   return "SHO";
}

function __paletteMapping( modeLabelOrMode, paletteText )
{
   var m = __normalizeModeLabel( modeLabelOrMode );

   if ( m === "RGB" )
      return { R: "R", G: "G", B: "B", palette: "RGB" };

   var p = (paletteText || "SHO").toString().trim().toUpperCase();

   if ( p === "HSO" )
      return { R: "Ha",  G: "Sii", B: "Oiii", palette: "HSO" };
   if ( p === "HOO" )
      return { R: "Ha",  G: "Oiii", B: "Oiii", palette: "HOO" };

   return { R: "Sii", G: "Ha",  B: "Oiii", palette: "SHO" };
}



function suggestPixelMathExpressionsFromStats( mappingOrMode, statsByChannel )
{
   var mapping = null;

   if ( typeof mappingOrMode === "string" )
      mapping = __paletteMapping( mappingOrMode, ( __normalizeModeLabel( mappingOrMode ) === "RGB" ) ? "RGB" : "SHO" );
   else
      mapping = mappingOrMode;

   if ( !mapping || !mapping.R || !mapping.G || !mapping.B )
      mapping = __paletteMapping( "RGB", "RGB" );

   var anchor = mapping.G;
   var redCh  = mapping.R;
   var bluCh  = mapping.B;

   function strengthOf( id )
   {
      try
      {
         var s = statsByChannel[id];
         if ( s && isFinite( s.strength ) && s.strength > 0 )
            return s.strength;
      }
      catch ( __e ) {}
      return NaN;
   }

   var a = strengthOf( anchor );
   var r = strengthOf( redCh );
   var b = strengthOf( bluCh );

   if ( !isFinite( a ) || a <= 0 || !isFinite( r ) || !isFinite( b ) )
   {
      return { R: redCh, G: anchor, B: bluCh };
   }

   var rRatio = r / a;
   var bRatio = b / a;

   var trigger = 0.85;
   var maxMix  = 0.35;

   function mixAlpha( ratio )
   {
      if ( ratio >= trigger ) return 0.0;
      var alpha = (trigger - ratio) / trigger * maxMix;
      return __clamp( alpha, 0.0, maxMix );
   }

   var aR = mixAlpha( rRatio );
   var aB = mixAlpha( bRatio );

   var expr = { R: "", G: anchor, B: "" };

   if ( aR > 0 )
      expr.R = "(" + redCh + " * " + __fmt( 1.0 - aR ) + ") + (" + anchor + " * " + __fmt( aR ) + ")";
   else
      expr.R = redCh;

   if ( aB > 0 )
      expr.B = "(" + bluCh + " * " + __fmt( 1.0 - aB ) + ") + (" + anchor + " * " + __fmt( aB ) + ")";
   else
      expr.B = bluCh;

   return expr;
}



var SBPP_SETTINGS_KEY = "Skynet/SBPP/Config";

function sbppUiLog( dlg, msg )
{
   try { Console.writeln( "<end><cbr>" + msg ); } catch ( __e1 ) {}
   try
   {
      if ( dlg && dlg.progress_Text )
         dlg.progress_Text.text += msg + "\n";
   }
   catch ( __e2 ) {}
   pumpEvents();
}

function sbppCollectConfig( dlg )
{
   var cfg = {};

   try { cfg.modeIndex = dlg.mode_Combo.currentItem; } catch ( __e ) {}
   try { cfg.mode = dlg.mode; } catch ( __e ) {}
   try { cfg.files = dlg.files ? dlg.files.slice( 0 ) : []; } catch ( __e ) {}
   try { cfg.outId = dlg.out_Edit.text; } catch ( __e ) {}
   try { cfg.paletteIndex = dlg.palette_Combo.currentItem; } catch ( __e ) {}
   try { cfg.combineUsePixelMath = dlg.combinePM_Radio ? dlg.combinePM_Radio.checked : false; } catch ( __e ) {}
   try { cfg.pmExprR = dlg.pmR_Edit ? dlg.pmR_Edit.text : ""; } catch ( __e ) {}
   try { cfg.pmExprG = dlg.pmG_Edit ? dlg.pmG_Edit.text : ""; } catch ( __e ) {}
   try { cfg.pmExprB = dlg.pmB_Edit ? dlg.pmB_Edit.text : ""; } catch ( __e ) {}

   try { cfg.refPolicyId = dlg.getReferencePolicyId ? dlg.getReferencePolicyId() : 2; } catch ( __e ) {}

   try { cfg.bgSmoothing = dlg.bgSmoothing_Edit.text; } catch ( __e ) {}

   try { cfg.nxtIterations = dlg.nxtIterations_Edit.text; } catch ( __e ) {}
   try { cfg.nxtDenoise = dlg.nxtDenoise_Edit.text; } catch ( __e ) {}
   try { cfg.bxtSharpenStars = dlg.bxtSharpenStars_Edit.text; } catch ( __e ) {}
   try { cfg.bxtAdjustHalos = dlg.bxtAdjustHalos_Edit.text; } catch ( __e ) {}
   try { cfg.bxtSharpenNonstellar = dlg.bxtSharpenNonstellar_Edit.text; } catch ( __e ) {}

   try { cfg.sxtUnscreen = dlg.sxtUnscreen_Check.checked; } catch ( __e ) {}
   try { cfg.sxtLargeOverlap = dlg.sxtLargeOverlap_Check.checked; } catch ( __e ) {}
   try { cfg.sxtGenerateStars = dlg.sxtGenerateStars_Check.checked; } catch ( __e ) {}

   try { cfg.stretch = dlg.stretch_Check.checked; } catch ( __e ) {}
   try { cfg.htTbg = dlg.htTbg_Edit.text; } catch ( __e ) {}

   try { cfg.masApply = dlg.masApply_Check.checked; } catch ( __e ) {}
   try { cfg.masPreview = dlg.masPreview_Check.checked; } catch ( __e ) {}
   try { cfg.masContrast = dlg.masContrast_Check.checked; } catch ( __e ) {}
   try { cfg.masTbg = dlg.masTbg_Edit.text; } catch ( __e ) {}
   try { cfg.masDRC = dlg.masDRC_Edit.text; } catch ( __e ) {}
   try { cfg.masAgg = dlg.masAgg_Edit.text; } catch ( __e ) {}
   try { cfg.masScale = (dlg.masScale_Combo ? dlg.masScale_Combo.itemText( dlg.masScale_Combo.currentItem ) : "1024");
   try { cfg.masCRIntensity = dlg.masCRIntensity_Edit ? dlg.masCRIntensity_Edit.text : "1.00"; } catch ( __e ) {} } catch ( __e ) {}
   try { cfg.masSatEnabled = dlg.masSatEnabled_Check.checked; } catch ( __e ) {}
   try { cfg.masSatLM = dlg.masSatLM_Check.checked; } catch ( __e ) {}
   try { cfg.masSatBoost = dlg.masSatBoost_Edit.text; } catch ( __e ) {}
   try { cfg.masSatAmt = dlg.masSatAmt_Edit.text; } catch ( __e ) {}

   try { cfg.nlNxtApply = dlg.nlNxtApply_Check.checked; } catch ( __e ) {}
   try { cfg.nlNxtIterations = dlg.nlNxtIterations_Edit.text; } catch ( __e ) {}
   try { cfg.nlNxtDenoise = dlg.nlNxtDenoise_Edit.text; } catch ( __e ) {}

   try { cfg.nlBxtApply = dlg.nlBxtApply_Check.checked; } catch ( __e ) {}
   try { cfg.nlBxtSharpenStars = dlg.nlBxtSharpenStars_Edit.text; } catch ( __e ) {}
   try { cfg.nlBxtAdjustHalos = dlg.nlBxtAdjustHalos_Edit.text; } catch ( __e ) {}
   try { cfg.nlBxtSharpenNonstellar = dlg.nlBxtSharpenNonstellar_Edit.text; } catch ( __e ) {}

   return cfg;
}

function sbppApplyConfig( dlg, cfg )
{
   if ( !cfg || typeof cfg !== "object" )
      return false;

   try
   {
      if ( cfg.modeIndex !== undefined && dlg.mode_Combo )
      {
         dlg.mode_Combo.currentItem = cfg.modeIndex;
         dlg.mode = ( dlg.mode_Combo.currentItem === 1 ) ? "RGB" : "SHO";
      }

      if ( cfg.mode !== undefined )
         dlg.mode = cfg.mode;

      if ( cfg.files && cfg.files.length && dlg.files )
         dlg.files = cfg.files.slice( 0 );

      if ( cfg.outId !== undefined && dlg.out_Edit )
         dlg.out_Edit.text = cfg.outId;

      if ( cfg.paletteIndex !== undefined && dlg.palette_Combo )
         dlg.palette_Combo.currentItem = cfg.paletteIndex;

      if ( cfg.refPolicyId !== undefined && dlg.setReferencePolicyId )
         dlg.setReferencePolicyId( cfg.refPolicyId );

 
      if ( cfg.combineUsePixelMath !== undefined && dlg.combineCC_Radio && dlg.combinePM_Radio )
      {
         dlg.combinePM_Radio.checked = !!cfg.combineUsePixelMath;
         dlg.combineCC_Radio.checked = !dlg.combinePM_Radio.checked;
      }

      if ( cfg.pmExprR !== undefined && dlg.pmR_Edit )
         dlg.pmR_Edit.text = cfg.pmExprR;

      if ( cfg.pmExprG !== undefined && dlg.pmG_Edit )
         dlg.pmG_Edit.text = cfg.pmExprG;

      if ( cfg.pmExprB !== undefined && dlg.pmB_Edit )
         dlg.pmB_Edit.text = cfg.pmExprB;


      if ( cfg.refPolicyId !== undefined )
{
   var pid = Number( cfg.refPolicyId );
   if ( !isFinite( pid ) ) pid = 2;
   pid = Math.round( pid );
   if ( pid < 0 || pid > 2 ) pid = 2;

   if ( dlg.refHigh_Radio && dlg.refMedium_Radio && dlg.refHighest_Radio )
   {
      dlg.refHighest_Radio.checked = (pid === 2);
      dlg.refMedium_Radio.checked  = (pid === 1);
      dlg.refHigh_Radio.checked    = (pid === 0);

      if ( !dlg.refHigh_Radio.checked && !dlg.refMedium_Radio.checked && !dlg.refHighest_Radio.checked )
         dlg.refHighest_Radio.checked = true;
   }
}

      if ( cfg.bgSmoothing !== undefined && dlg.bgSmoothing_Edit )
         dlg.bgSmoothing_Edit.text = cfg.bgSmoothing;

      if ( cfg.nxtIterations !== undefined && dlg.nxtIterations_Edit )
         dlg.nxtIterations_Edit.text = cfg.nxtIterations;

      if ( cfg.nxtDenoise !== undefined && dlg.nxtDenoise_Edit )
         dlg.nxtDenoise_Edit.text = cfg.nxtDenoise;

      if ( cfg.bxtSharpenStars !== undefined && dlg.bxtSharpenStars_Edit )
         dlg.bxtSharpenStars_Edit.text = cfg.bxtSharpenStars;

      if ( cfg.bxtAdjustHalos !== undefined && dlg.bxtAdjustHalos_Edit )
         dlg.bxtAdjustHalos_Edit.text = cfg.bxtAdjustHalos;

      if ( cfg.bxtSharpenNonstellar !== undefined && dlg.bxtSharpenNonstellar_Edit )
         dlg.bxtSharpenNonstellar_Edit.text = cfg.bxtSharpenNonstellar;

      if ( cfg.sxtUnscreen !== undefined && dlg.sxtUnscreen_Check )
         dlg.sxtUnscreen_Check.checked = !!cfg.sxtUnscreen;

      if ( cfg.sxtLargeOverlap !== undefined && dlg.sxtLargeOverlap_Check )
         dlg.sxtLargeOverlap_Check.checked = !!cfg.sxtLargeOverlap;

      if ( cfg.sxtGenerateStars !== undefined && dlg.sxtGenerateStars_Check )
         dlg.sxtGenerateStars_Check.checked = !!cfg.sxtGenerateStars;

      if ( cfg.stretch !== undefined && dlg.stretch_Check )
         dlg.stretch_Check.checked = !!cfg.stretch;

       if ( cfg.htTbg !== undefined && dlg.htTbg_Edit )
          dlg.htTbg_Edit.text = cfg.htTbg;

      if ( cfg.masApply !== undefined && dlg.masApply_Check )
         dlg.masApply_Check.checked = !!cfg.masApply;

      if ( cfg.masPreview !== undefined && dlg.masPreview_Check )
         dlg.masPreview_Check.checked = !!cfg.masPreview;

      if ( cfg.masContrast !== undefined && dlg.masContrast_Check )
         dlg.masContrast_Check.checked = !!cfg.masContrast;

      if ( cfg.masTbg !== undefined && dlg.masTbg_Edit )
         dlg.masTbg_Edit.text = cfg.masTbg;

      if ( cfg.masDRC !== undefined && dlg.masDRC_Edit )
         dlg.masDRC_Edit.text = cfg.masDRC;

      if ( cfg.masAgg !== undefined && dlg.masAgg_Edit )
         dlg.masAgg_Edit.text = cfg.masAgg;

      if ( cfg.masScale !== undefined && dlg.masScale_Combo )
{
   var __ms = String( cfg.masScale );
   var __idx = -1;
   for ( var __i = 0; __i < dlg.masScale_Combo.numberOfItems; ++__i )
      if ( String( dlg.masScale_Combo.itemText( __i ) ) === __ms ) { __idx = __i; break; }
   if ( __idx < 0 )
      __idx = 10; // default 1024
   dlg.masScale_Combo.currentItem = __idx;
}

if ( cfg.masCRIntensity !== undefined && dlg.masCRIntensity_Edit && dlg.masCRIntensity_Slider )
{
   var __ci = Number( cfg.masCRIntensity );
   if ( !isFinite( __ci ) ) __ci = 1.0;
   __ci = Math.range( __ci, 0.0, 1.0 );
   dlg.masCRIntensity_Slider.value = Math.round( __ci * 1000 );
   dlg.masCRIntensity_Edit.text = format( "%.2f", __ci );
}



      if ( cfg.masSatEnabled !== undefined && dlg.masSatEnabled_Check )
         dlg.masSatEnabled_Check.checked = !!cfg.masSatEnabled;

      if ( cfg.masSatLM !== undefined && dlg.masSatLM_Check )
         dlg.masSatLM_Check.checked = !!cfg.masSatLM;

      if ( cfg.masSatBoost !== undefined && dlg.masSatBoost_Edit )
         dlg.masSatBoost_Edit.text = cfg.masSatBoost;

      if ( cfg.masSatAmt !== undefined && dlg.masSatAmt_Edit )
         dlg.masSatAmt_Edit.text = cfg.masSatAmt;

      if ( cfg.nlNxtApply !== undefined && dlg.nlNxtApply_Check )
         dlg.nlNxtApply_Check.checked = !!cfg.nlNxtApply;

      if ( cfg.nlNxtIterations !== undefined && dlg.nlNxtIterations_Edit )
         dlg.nlNxtIterations_Edit.text = cfg.nlNxtIterations;

      if ( cfg.nlNxtDenoise !== undefined && dlg.nlNxtDenoise_Edit )
         dlg.nlNxtDenoise_Edit.text = cfg.nlNxtDenoise;

      if ( cfg.nlBxtApply !== undefined && dlg.nlBxtApply_Check )
         dlg.nlBxtApply_Check.checked = !!cfg.nlBxtApply;

      if ( cfg.nlBxtSharpenStars !== undefined && dlg.nlBxtSharpenStars_Edit )
         dlg.nlBxtSharpenStars_Edit.text = cfg.nlBxtSharpenStars;

      if ( cfg.nlBxtAdjustHalos !== undefined && dlg.nlBxtAdjustHalos_Edit )
         dlg.nlBxtAdjustHalos_Edit.text = cfg.nlBxtAdjustHalos;

      if ( cfg.nlBxtSharpenNonstellar !== undefined && dlg.nlBxtSharpenNonstellar_Edit )
         dlg.nlBxtSharpenNonstellar_Edit.text = cfg.nlBxtSharpenNonstellar;

      return true;
   }
   catch ( __e )
   {
      return false;
   }
}

function sbppTryLoadLastConfiguration( dlg )
{
   sbppUiLog( dlg, "Attempting to retrieve last configuration" );

   try
   {
      if ( typeof Settings === "undefined" )
      {
         sbppUiLog( dlg, "Warning: Last configuration not found" );
         return false;
      }

      var json = Settings.read( SBPP_SETTINGS_KEY, DataType_String );
      if ( json === null || json === undefined || ("" + json).length === 0 )
      {
         sbppUiLog( dlg, "Warning: Last configuration not found" );
         return false;
      }

      sbppUiLog( dlg, "Last configuration found" );

      var cfg = JSON.parse( json );

      if ( !sbppApplyConfig( dlg, cfg ) )
      {
         sbppUiLog( dlg, "Warning: Last configuration couldn't be loaded" );
         return false;
      }

      sbppUiLog( dlg, "Last configuration loaded successfully" );
      return true;
   }
   catch ( __e )
   {
      try { Console.writeln( "[SBPP] Load exception: " + __e ); } catch ( __e2 ) {}
      sbppUiLog( dlg, "Warning: Last configuration couldn't be loaded" );
      return false;
   }
}

function sbppTrySaveCurrentConfiguration( dlg, logFn )
{
   var log = ( typeof logFn === "function" ) ? logFn : function( s ){ sbppUiLog( dlg, s ); };

   log( "Attempting to save current configuration" );

   try
   {
      if ( typeof Settings === "undefined" )
      {
         log( "Warning: Couldn't save current configuration" );
         return false;
      }

      var cfg = sbppCollectConfig( dlg );
      var json = JSON.stringify( cfg );
      Settings.write( SBPP_SETTINGS_KEY, DataType_String, json );

      log( "Current configuration successfully saved" );
      return true;
   }
   catch ( __e )
   {
      try { Console.writeln( "[SBPP] Save exception: " + __e ); } catch ( __e2 ) {}
      log( "Warning: Couldn't save current configuration" );
      return false;
   }
}


function guessKeyFromFilename( path )
{
   var s = path.toLowerCase();
   function hasToken( re ) { return re.test( s ); }

   if ( hasToken( /(^|[^a-z0-9])(ha|h[-_ ]?a)([^a-z0-9]|$)/ ) ) return "Ha";
   if ( hasToken( /(^|[^a-z0-9])(sii|s2|s[-_ ]?ii)([^a-z0-9]|$)/ ) ) return "Sii";
   if ( hasToken( /(^|[^a-z0-9])(oiii|o3|o[-_ ]?iii)([^a-z0-9]|$)/ ) ) return "Oiii";

   if ( hasToken( /(^|[^a-z0-9])(r|red)([^a-z0-9]|$)/ ) ) return "R";
   if ( hasToken( /(^|[^a-z0-9])(g|green)([^a-z0-9]|$)/ ) ) return "G";
   if ( hasToken( /(^|[^a-z0-9])(b|blue)([^a-z0-9]|$)/ ) ) return "B";

   return "";
}

function openImage( filePath )
{
   var w = ImageWindow.open( filePath );
   if ( w.length < 1 )
      throw new Error( "Unable to open: " + filePath );

   pumpEvents();
   return w[0];
}

function renameMainViewTo( view, desiredId )
{
   if ( view == null || desiredId == null || !desiredId.length )
      return;

   var id = desiredId;
   var n = 1;

   for ( ;; )
   {
      var existing = ImageWindow.windowById( id );
      if ( existing == null || existing.isNull || existing === view.window )
         break;

      id = desiredId + "_" + n;
      ++n;
   }

   try
   {
      view.id = id;
      pumpEvents();
   }
   catch ( e )
   {
   }
}


function calculateMean( viewId )
{
   var view = View.viewById( viewId );

   if ( !view )
   {
      Console.warningln( "View not found: " + viewId + ". Trying '_registered' version." );
      view = View.viewById( viewId + "_registered" );
   }

   if ( view )
   {
      var st = getRobustViewStats( view );
      var mean = (st && isFinite( st.mean )) ? st.mean : 0;

      Console.writeln( "Mean value for " + viewId + ": " + format( "%.6f", mean ) );
      return mean;
   }

   Console.warningln( "Failed to calculate mean for: " + viewId );
   return 0;
}


function applyVisualSTF( view, shadowsClipping, targetBackground, rgbLinked )
{
   if ( view == null || view.isNull )
      return;

   if ( shadowsClipping == undefined ) shadowsClipping = DEFAULT_AUTOSTRETCH_SCLIP;
   if ( targetBackground == undefined ) targetBackground = DEFAULT_AUTOSTRETCH_TBGND;
   if ( rgbLinked == undefined ) rgbLinked = DEFAULT_AUTOSTRETCH_CLINK;

   var stf = new ScreenTransferFunction;
   var n = view.image.isColor ? 3 : 1;

   var median = view.computeOrFetchProperty( "Median" );
   var mad = view.computeOrFetchProperty( "MAD" );
   mad.mul( 1.4826 );

   if ( rgbLinked )
   {
      var invertedChannels = 0;
      for ( var c = 0; c < n; ++c )
         if ( median.at( c ) > 0.5 ) ++invertedChannels;

      if ( invertedChannels < n )
      {
         var c0 = 0, m = 0;
         for ( var c = 0; c < n; ++c )
         {
            if ( 1 + mad.at( c ) != 1 )
               c0 += median.at( c ) + shadowsClipping * mad.at( c );
            m += median.at( c );
         }

         c0 = Math.range( c0/n, 0.0, 1.0 );
         m  = Math.mtf( targetBackground, m/n - c0 );

         stf.STF = [
            [c0, 1, m, 0, 1],
            [c0, 1, m, 0, 1],
            [c0, 1, m, 0, 1],
            [0, 1, 0.5, 0, 1]
         ];
      }
      else
      {
         var c1 = 0, m = 0;
         for ( var c = 0; c < n; ++c )
         {
            m += median.at( c );
            if ( 1 + mad.at( c ) != 1 )
               c1 += median.at( c ) - shadowsClipping * mad.at( c );
            else
               c1 += 1;
         }

         c1 = Math.range( c1/n, 0.0, 1.0 );
         m  = Math.mtf( c1 - m/n, targetBackground );

         stf.STF = [
            [0, c1, m, 0, 1],
            [0, c1, m, 0, 1],
            [0, c1, m, 0, 1],
            [0, 1, 0.5, 0, 1]
         ];
      }
   }
   else
   {
      var A = [
         [0, 1, 0.5, 0, 1],
         [0, 1, 0.5, 0, 1],
         [0, 1, 0.5, 0, 1],
         [0, 1, 0.5, 0, 1]
      ];

      for ( var c = 0; c < n; ++c )
      {
         if ( median.at( c ) < 0.5 )
         {
            var c0 = (1 + mad.at( c ) != 1) ? Math.range( median.at( c ) + shadowsClipping * mad.at( c ), 0.0, 1.0 ) : 0.0;
            var m  = Math.mtf( targetBackground, median.at( c ) - c0 );
            A[c] = [c0, 1, m, 0, 1];
         }
         else
         {
            var c1 = (1 + mad.at( c ) != 1) ? Math.range( median.at( c ) - shadowsClipping * mad.at( c ), 0.0, 1.0 ) : 1.0;
            var m  = Math.mtf( c1 - median.at( c ), targetBackground );
            A[c] = [0, c1, m, 0, 1];
         }
      }

      stf.STF = A;
   }

   stf.executeOn( view, false );
   pumpEvents();
}



function linearFitToID( referenceViewId, targetViewId, logFn )
{
   var targetView = View.viewById( targetViewId );
   if ( targetView == null )
   {
      Console.warningln( "Target view not found: " + targetViewId );
      logFn( "Target view not found: " + targetViewId );
      return;
   }

   var P = new LinearFit;
   P.referenceViewId = referenceViewId;
   P.rejectLow = 0.0;
   P.rejectHigh = 0.92;

   if ( !P.executeOn( targetView ) )
   {
      Console.warningln( "Linear Fit failed on target: " + targetViewId );
      logFn( "Linear Fit failed on target: " + targetViewId );
   }
   else
   {
      Console.writeln( "Linear Fit applied to " + targetViewId + " using reference " + referenceViewId );
      logFn( "Linear Fit applied to " + targetViewId + " using reference " + referenceViewId );
   }

   pumpEvents();
}

function combineToRGB( rId, gId, bId, outId )
{
   function sanitizeId( s )
   {
      s = (s || "").trim();
      if ( s.length < 1 ) s = "RGB";
      s = s.replace( /[^A-Za-z0-9_]/g, "_" );
      if ( /^[0-9]/.test( s ) ) s = "I_" + s;
      return s;
   }

   outId = sanitizeId( outId );

   var CC = new ChannelCombination;

   CC.colorSpace = ChannelCombination.prototype.RGB;

   CC.channels = [
      [ true, rId ],
      [ true, gId ],
      [ true, bId ]
   ];

   CC.createNewImage = true;
   CC.newImageId = outId;

   var before = ImageWindow.activeWindow;

   if ( !CC.executeGlobal() )
      throw new Error( "ChannelCombination failed." );

   var outWin = ImageWindow.activeWindow;
   if ( outWin == null || outWin.isNull )
      throw new Error( "ChannelCombination did not produce an output window." );

   if ( before && !before.isNull && outWin === before )
      Console.warningln( "Warning: activeWindow did not change after ChannelCombination. Proceeding anyway." );

   renameMainViewTo( outWin.mainView, outId );

   outWin.show();
   ImageWindow.activeWindow = outWin;
   outWin.bringToFront();

   pumpEvents();

   applyVisualSTF( outWin.mainView, DEFAULT_AUTOSTRETCH_SCLIP, DEFAULT_AUTOSTRETCH_TBGND, false );

   return outWin.mainView;
}



function firstExistingId( ids )
{
   for ( var i = 0; i < ids.length; ++i )
   {
      var id = ids[i];
      if ( id == null ) continue;
      var w = ImageWindow.windowById( id );
      if ( w && !w.isNull )
         return id;
   }
   return null;
}

function WorkflowDialog()
{
   if ( !sbppValidatePrerequisites() )
      throw new Error( "__SBPP_PREREQ__" );

   this.__base__ = Dialog;
   this.__base__();
   var dlg = this;

   this.windowTitle = "Skynet Batch Post-Processing (v1.95 Skynet Observatory, © 2026)";
   this.mode = "SHO";
   this.files = [];
   this.detected = [];

   this.__userHasSelectedFiles = false;
   this.__statsReady = false;

   function row( parent, labelText, control )
   {
      var h = new HorizontalSizer;
      h.spacing = 8;

      var l = new Label( parent );
      l.text = labelText;
      l.textAlignment = 2 | 8;
      l.setFixedWidth( 120 );

      h.add( l );
      h.add( control, 100 );

      return h;
   }
   function row2( parent, labelText1, control1, labelText2, control2 )
   {
      var h = new HorizontalSizer; h.spacing = 6;

      var l1 = new Label( parent ); l1.text = labelText1; l1.textAlignment = 2 | 8; l1.setFixedWidth( 120 );
      h.add( l1 );
      h.add( control1, 50 );

      if ( labelText2 != null && control2 != null )
      {
         h.addSpacing( 10 );
         var l2 = new Label( parent ); l2.text = labelText2; l2.textAlignment = 2 | 8; l2.setFixedWidth( 120 );
         h.add( l2 );
         h.add( control2, 50 );
      }

      return h;
   }

   function section( title, control, expanded )
   {
      var bar = new SectionBar( dlg );
      bar.setTitle( title );

      if ( expanded === undefined ) expanded = true;

      try { bar.setSection( control ); } catch ( __e ) {}

      bar.onToggleSection = function()
      {
         if ( dlg.__inSectionToggle )
            return;

         dlg.__inSectionToggle = true;
         try
         {
            try { control.adjustToContents(); } catch ( __e1 ) {}
            try { dlg.sizer.adjustToContents(); } catch ( __e2 ) {}
            dlg.adjustToContents();

            dlg.update();
            dlg.repaint();
         }
         finally
         {
            dlg.__inSectionToggle = false;
         }
      };


      control.visible = expanded;
      var v = new VerticalSizer;
      v.spacing = 4;
      v.add( bar );
      v.add( control );

      return v;
   }

   function clamp( x, lo, hi )
   {
      x = Number( x );
      if ( isNaN( x ) ) x = lo;
      if ( x < lo ) x = lo;
      if ( x > hi ) x = hi;
      return x;
   }

   function setEditNumber( edit, value, decimals )
   {
      if ( decimals == undefined ) decimals = 2;
      edit.text = value.toFixed( decimals );
   }

   function setLabelText( label, text )
   {
      label.text = text;
      pumpEvents();
   }


   this.mode_Combo = new ComboBox( this );
   this.mode_Combo.addItem( "SHO (Sii, Ha, Oiii)" );
   this.mode_Combo.addItem( "RGB (Red, Green, Blue)" );

   this.pick_Button = new PushButton( this );
   this.pick_Button.text = "Select Master Files...";
   this.pick_Button.setFixedHeight( 60 );
   
   this.detected_Text = new TextBox( this );
   this.detected_Text.readOnly = true;
   this.detected_Text.setScaledMinHeight( 100 );

   this.stats_Label = new Label( this );
   this.stats_Label.useRichText = false;
   this.stats_Label.textAlignment = 0 | 8;
   this.stats_Label.margin = 0;
   try
   {
      var __sf = new Font( "Courier New", 9 );
      try { __sf.bold = true; } catch ( __eBold1 ) {}
      this.stats_Label.font = __sf;
   }
   catch ( __eFont ) {}
   this.stats_Label.setFixedHeight( 100 );

   this.stats_Panel = new Control( this );
   try { this.stats_Panel.frameStyle = FrameStyle_Box; } catch ( __eFS ) {}
   try { this.stats_Panel.backgroundColor = 0xFFE8E8E8; } catch ( __eBG ) {}
   this.stats_Panel.sizer = new VerticalSizer;
   this.stats_Panel.sizer.margin = 6;
   this.stats_Panel.sizer.spacing = 0;
   this.stats_Panel.sizer.add( this.stats_Label );
   try { this.stats_Panel.setFixedHeight( 126 ); } catch ( __eH ) {}

   this.legend_Label = new Label( this );
   this.legend_Label.useRichText = false;
   this.legend_Label.textAlignment = 0 | 8;
   this.legend_Label.margin = 0;
   try
   {
      var __lf = new Font( "Courier New", 9 );
      try { __lf.bold = true; } catch ( __eBold2 ) {}
      this.legend_Label.font = __lf;
   }
   catch ( __eFont2 ) {}
   this.legend_Label.text = "";
   this.legend_Label.setFixedHeight( 100 );

   this.legend_Panel = new Control( this );
   try { this.legend_Panel.frameStyle = FrameStyle_Box; } catch ( __eLFS ) {}
   try { this.legend_Panel.backgroundColor = 0xFFE8E8E8; } catch ( __eLBG ) {}
   this.legend_Panel.sizer = new VerticalSizer;
   this.legend_Panel.sizer.margin = 6;
   this.legend_Panel.sizer.spacing = 0;
   this.legend_Panel.sizer.add( this.legend_Label );
   try { this.legend_Panel.setFixedHeight( 126 ); } catch ( __eLH ) {}


   this.refHigh_Radio = new RadioButton( this );
   this.refHigh_Radio.text = "Use lowest signal value";

   this.refMedium_Radio = new RadioButton( this );
   this.refMedium_Radio.text = "Use medium signal value";

   this.refHighest_Radio = new RadioButton( this );
   this.refHighest_Radio.text = "Use highest signal value";
   this.refHighest_Radio.checked = true;

   if ( this.refHigh_Radio && this.refMedium_Radio && this.refHighest_Radio )
      this.refHighest_Radio.checked = true;



   this.out_Edit = new Edit( this );
   this.out_Edit.text = "RGB";
   this.out_Edit.setFixedWidth( 110 );

   this.help_Button = new PushButton( this );
   this.help_Button.text = "?";
   this.help_Button.toolTip = "Show SBPP workflow guide";
   this.help_Button.setFixedWidth( 26 );
   this.help_Button.onClick = function()
   {
      try
      {
         sbppShowHelpDialog();
      }
      catch ( e )
      {
         try
         {
            new MessageBox( "Help dialog error: " + e, "SBPP", StdIcon_Error, StdButton_Ok ).execute();
         }
         catch ( __ )
         {
            Console.criticalln( "[SBPP] Help dialog error: " + e );
         }
      }
   };

   this.outHelp_Control = new Control( this );
   this.outHelp_Control.sizer = new HorizontalSizer;
   this.outHelp_Control.sizer.spacing = 4;
   this.outHelp_Control.sizer.add( this.out_Edit );
   this.outHelp_Control.sizer.add( this.help_Button );


   this.bgSmoothing_Edit = new Edit( this );
   this.bgSmoothing_Edit.text = "0.50";
   this.bgSmoothing_Edit.toolTip = "GraXpert smoothing. Range 0.0 to 1.0";

   this.bgHint_Label = new Label( this );
   this.bgHint_Label.text = "Tip: 0.0 keeps more structure, 1.0 smooths more aggressively";
   this.bgHint_Label.textColor = 0xFF808080;


   this.lf_InfoLabel = new Label( this );
   this.lf_InfoLabel.text = "LinearFit using (select files) as Reference";


   this.psf_InfoLabel = new Label( this );
   this.psf_InfoLabel.text = "BlurX applied with Correct Only option";


   this.combineCC_Radio = new RadioButton( this );
   this.combineCC_Radio.text = "Use Channel Combination";
   this.combineCC_Radio.checked = true;

   this.palette_Combo = new ComboBox( this );
   this.palette_Combo.toolTip = "Channel mapping palette used during combination.";

   this.combinePM_Radio = new RadioButton( this );
   this.combinePM_Radio.text = "Use Pixel Math Expression";
   this.combinePM_Radio.checked = false;

   this.pmR_Edit = new Edit( this );
   this.pmR_Edit.toolTip = "PixelMath expression for the Red channel output.";

   this.pmG_Edit = new Edit( this );
   this.pmG_Edit.toolTip = "PixelMath expression for the Green channel output.";

   this.pmB_Edit = new Edit( this );
   this.pmB_Edit.toolTip = "PixelMath expression for the Blue channel output.";

   this.pmR_Edit.setFixedWidth( 260 );
   this.pmG_Edit.setFixedWidth( 260 );
   this.pmB_Edit.setFixedWidth( 260 );

   this.pmInit_Button = new PushButton( this );
   this.pmInit_Button.text = "Initialize";
   this.pmInit_Button.toolTip = "Reset PixelMath expressions to mode defaults.";
   this.pmInit_Button.setFixedWidth( 90 );
   this.pmInit_Button.setFixedHeight( 22 );



   this.pmResume_Button = new PushButton( this );
   this.pmResume_Button.text = "Resume";
   this.pmResume_Button.toolTip = "Continue the workflow after reviewing PixelMath expressions.";
   this.pmResume_Button.setFixedWidth( 90 );
   this.pmResume_Button.setFixedHeight( 22 );
   this.pmResume_Button.enabled = false;


   this.spcc_InfoLabel = new Label( this );
   this.spcc_InfoLabel.text = "SPCC settings applied according to Mode";


   this.nxtDenoise_Edit = new Edit( this );
   this.nxtDenoise_Edit.text = "0.50";

   this.nxtDenoise_Slider = new Slider( this );
   this.nxtDenoise_Slider.minValue = 0;
   this.nxtDenoise_Slider.maxValue = 1000;
   this.nxtDenoise_Slider.pageSize = 50;
   this.nxtDenoise_Slider.tracking = true;
   this.nxtDenoise_Slider.setRange( 0, 1000 );
   this.nxtDenoise_Slider.value = 500;

   this.nxtIterations_Edit = new Edit( this );
   this.nxtIterations_Edit.text = "1";
   this.nxtIterations_Edit.toolTip = "Allowed values: 1 or 2";

   this.nxtHint_Label = new Label( this );
   this.nxtHint_Label.text = "Tip: use 2 iterations only if the background is clearly noisy";
   this.nxtHint_Label.textColor = 0xFF808080;


   this.bxtSharpenStars_Edit = new Edit( this );
   this.bxtSharpenStars_Edit.text = "0.50";

   this.bxtAdjustHalos_Edit = new Edit( this );
   this.bxtAdjustHalos_Edit.text = "-0.10";

   this.bxtSharpenNonstellar_Edit = new Edit( this );
   this.bxtSharpenNonstellar_Edit.text = "0.50";

   this.bxtHint_Label = new Label( this );
   this.bxtHint_Label.text = "Tip: negative halos reduces star bloat; keep star sharpening modest";
   this.bxtHint_Label.textColor = 0xFF808080;


   this.sxtGenerateStars_Check = new CheckBox( this );
   this.sxtGenerateStars_Check.text = "Generate Star Image";
   this.sxtGenerateStars_Check.checked = true;

   this.sxtUnscreen_Check = new CheckBox( this );
   this.sxtUnscreen_Check.text = "Unscreen Stars";
   this.sxtUnscreen_Check.checked = true;

   this.sxtLargeOverlap_Check = new CheckBox( this );
   this.sxtLargeOverlap_Check.text = "Large Overlap";
   this.sxtLargeOverlap_Check.checked = true;

   this.sxtHint_Label = new Label( this );
   this.sxtHint_Label.text = "Large Overlap uses 0.50 (unchecked uses 0.20)";
   this.sxtHint_Label.textColor = 0xFF808080;



   this.stretch_Check = new CheckBox( this );
   this.stretch_Check.text = "Apply a HistogramTransformation stretch (STF to HT style).";
   this.stretch_Check.checked = true;

   this.ht_Group = new GroupBox( this );
   this.ht_Group.title = "10.1 Histogram Transformation";
   this.ht_Group.checkable = false;

   this.ht_Group.sizer = new VerticalSizer;
   this.ht_Group.sizer.margin = 6;
   this.ht_Group.sizer.spacing = 4;
this.htTbg_Label = new Label( this );
this.htTbg_Label.text = "TBGND:";
this.htTbg_Label.textAlignment = 2|8;
this.htTbg_Label.setFixedWidth( 60 );

this.htTbg_Edit = new Edit( this );
this.htTbg_Edit.text = "0.25";
this.htTbg_Edit.setFixedWidth( 60 );
this.htTbg_Edit.toolTip = "Target background used when converting STF-style stretch to HT (0.00 to 1.00).";

this.htTbg_Edit.onTextUpdated = function( s )
{
   var v = parseFloat( s );
   if ( isNaN( v ) ) v = DEFAULT_AUTOSTRETCH_TBGND;
   if ( v < 0 ) v = 0;
   if ( v > 1 ) v = 1;
   this.text = format( "%.2f", v );
};

var htRow = new HorizontalSizer;
htRow.spacing = 6;
htRow.add( this.stretch_Check );
htRow.add( this.htTbg_Label );
htRow.add( this.htTbg_Edit );
htRow.addStretch();
this.ht_Group.sizer.add( htRow );

   this.mas_Group = new GroupBox( this );
   this.mas_Group.title = "10.2 Multiscale Adaptive Stretch";
   this.mas_Group.checkable = false;

   this.masApply_Check = new CheckBox( this );
   this.masApply_Check.text = "Apply Multiscale Adaptive Stretch";
   this.masApply_Check.checked = false;

   this.masAgg_Edit = new Edit( this );          this.masAgg_Edit.text = "0.70";
   this.masAgg_Slider = new Slider( this );     this.masAgg_Slider.minValue = 0; this.masAgg_Slider.maxValue = 100; this.masAgg_Slider.value = 70;

   this.masTbg_Edit = new Edit( this );         this.masTbg_Edit.text = "0.15";
   this.masTbg_Slider = new Slider( this );     this.masTbg_Slider.minValue = 0; this.masTbg_Slider.maxValue = 100; this.masTbg_Slider.value = 15;

   this.masDRC_Edit = new Edit( this );         this.masDRC_Edit.text = "0.40";
   this.masDRC_Slider = new Slider( this );     this.masDRC_Slider.minValue = 0; this.masDRC_Slider.maxValue = 100; this.masDRC_Slider.value = 40;

   this.masContrast_Check = new CheckBox( this );        this.masContrast_Check.text = "Contrast Recovery"; this.masContrast_Check.checked = true;

   this.masScale_Combo = new ComboBox( this );
   this.masScale_Combo.addItem( "8" );
   this.masScale_Combo.addItem( "16" );
   this.masScale_Combo.addItem( "32" );
   this.masScale_Combo.addItem( "64" );
   this.masScale_Combo.addItem( "128" );
   this.masScale_Combo.addItem( "192" );
   this.masScale_Combo.addItem( "256" );
   this.masScale_Combo.addItem( "384" );
   this.masScale_Combo.addItem( "512" );
   this.masScale_Combo.addItem( "768" );
   this.masScale_Combo.addItem( "1024" );
   this.masScale_Combo.currentItem = 10;
   
this.masCRIntensity_Edit = new Edit( this );
this.masCRIntensity_Edit.text = "1.00";
this.masCRIntensity_Edit.setFixedWidth( 60 );
this.masCRIntensity_Edit.toolTip = "Contrast Recovery Intensity (0.00 to 1.00).";

this.masCRIntensity_Slider = new Slider( this );
this.masCRIntensity_Slider.minValue = 0;
this.masCRIntensity_Slider.maxValue = 1000;
this.masCRIntensity_Slider.pageSize = 50;
this.masCRIntensity_Slider.tracking = true;
this.masCRIntensity_Slider.setRange( 0, 1000 );
this.masCRIntensity_Slider.value = 1000;

this.masPreview_Check = new CheckBox( this );         this.masPreview_Check.text = "Preview Large Scale"; this.masPreview_Check.checked = false;

   this.masSatEnabled_Check = new CheckBox( this );      this.masSatEnabled_Check.text = "Enable Saturation"; this.masSatEnabled_Check.checked = true;

   this.masSatAmt_Edit = new Edit( this );      this.masSatAmt_Edit.text = "0.75";
   this.masSatAmt_Slider = new Slider( this );  this.masSatAmt_Slider.minValue = 0; this.masSatAmt_Slider.maxValue = 100; this.masSatAmt_Slider.value = 75;

   this.masSatBoost_Edit = new Edit( this );    this.masSatBoost_Edit.text = "0.50";
   this.masSatBoost_Slider = new Slider( this );this.masSatBoost_Slider.minValue = 0; this.masSatBoost_Slider.maxValue = 100; this.masSatBoost_Slider.value = 50;

   this.masSatLM_Check = new CheckBox( this );           this.masSatLM_Check.text = "Saturation Lightness Mask"; this.masSatLM_Check.checked = true;

function linkEditSlider01( edit, slider )
{
   function clamp01( x )
   {
      x = parseFloat( x );
      if ( isNaN( x ) ) x = 0;
      if ( x < 0 ) x = 0;
      if ( x > 1 ) x = 1;
      return x;
   }

   edit.onTextUpdated = function( s )
   {
      var v = clamp01( s );
      slider.value = Math.round( v * 100 );
      edit.text = format( "%.2f", v );
   };

   slider.onValueUpdated = function( v )
   {
      edit.text = format( "%.2f", v / 100 );
   };
}

// 0..1 slider with higher resolution (default k=1000 => 0.001 steps)
function linkEditSlider01k( edit, slider, k )
{
   if ( k === undefined ) k = 1000;

   function clamp01( x )
   {
      x = parseFloat( x );
      if ( isNaN( x ) ) x = 0;
      if ( x < 0 ) x = 0;
      if ( x > 1 ) x = 1;
      return x;
   }

   edit.onTextUpdated = function( s )
   {
      var v = clamp01( s );
      slider.value = Math.round( v * k );
      edit.text = format( "%.2f", v );
   };

   slider.onValueUpdated = function( v )
   {
      edit.text = format( "%.2f", v / k );
   };
}

   linkEditSlider01( this.masAgg_Edit, this.masAgg_Slider );
   linkEditSlider01( this.masTbg_Edit, this.masTbg_Slider );
   linkEditSlider01( this.masDRC_Edit, this.masDRC_Slider );
   linkEditSlider01( this.masSatAmt_Edit, this.masSatAmt_Slider );
   linkEditSlider01( this.masSatBoost_Edit, this.masSatBoost_Slider );

   linkEditSlider01k( this.masCRIntensity_Edit, this.masCRIntensity_Slider, 1000 );

   var MAS_SLIDER_W = 480;
   this.masAgg_Slider.setFixedWidth( MAS_SLIDER_W );
   this.masTbg_Slider.setFixedWidth( MAS_SLIDER_W );
   this.masDRC_Slider.setFixedWidth( MAS_SLIDER_W );
   this.masSatAmt_Slider.setFixedWidth( MAS_SLIDER_W );
   this.masSatBoost_Slider.setFixedWidth( MAS_SLIDER_W );
   this.masCRIntensity_Slider.setFixedWidth( MAS_SLIDER_W );

   this.mas_Group.sizer = new VerticalSizer;
   this.mas_Group.sizer.margin = 6;
   this.mas_Group.sizer.spacing = 6;

   this.mas_Group.sizer.add( this.masApply_Check );

   var MAS_LABEL_W = 180;

   var masRow1 = new HorizontalSizer; masRow1.spacing = 6;
   var masAggLabel = new Label( this ); masAggLabel.text = "Aggressiveness:"; masAggLabel.textAlignment = 2 | 8; masAggLabel.setFixedWidth( MAS_LABEL_W );
   masRow1.add( masAggLabel ); masRow1.add( this.masAgg_Edit ); masRow1.add( this.masAgg_Slider );
   this.mas_Group.sizer.add( masRow1 );

   var masRow2 = new HorizontalSizer; masRow2.spacing = 6;
   var masTbgLabel = new Label( this ); masTbgLabel.text = "Target Background:"; masTbgLabel.textAlignment = 2 | 8; masTbgLabel.setFixedWidth( MAS_LABEL_W );
   masRow2.add( masTbgLabel ); masRow2.add( this.masTbg_Edit ); masRow2.add( this.masTbg_Slider );
   this.mas_Group.sizer.add( masRow2 );

   var masRow3 = new HorizontalSizer; masRow3.spacing = 6;
   var masDRCLabel = new Label( this ); masDRCLabel.text = "Dynamic Range Compression:"; masDRCLabel.textAlignment = 2 | 8; masDRCLabel.setFixedWidth( MAS_LABEL_W );
   masRow3.add( masDRCLabel ); masRow3.add( this.masDRC_Edit ); masRow3.add( this.masDRC_Slider );
   this.mas_Group.sizer.add( masRow3 );

   this.mas_Group.sizer.add( this.masContrast_Check );

   var masRow4 = new HorizontalSizer; masRow4.spacing = 6;
var masScaleLabel = new Label( this ); masScaleLabel.text = "Scale Separation:"; masScaleLabel.textAlignment = 2 | 8; masScaleLabel.setFixedWidth( MAS_LABEL_W );
this.masScale_Combo.setFixedWidth( 110 );

var masIntLabel = new Label( this ); masIntLabel.text = "Intensity:"; masIntLabel.textAlignment = 2 | 8; masIntLabel.setFixedWidth( 90 );

masRow4.add( masScaleLabel );
masRow4.add( this.masScale_Combo );
masRow4.addSpacing( 12 );
masRow4.add( masIntLabel );
masRow4.add( this.masCRIntensity_Edit );
masRow4.add( this.masCRIntensity_Slider );
masRow4.addStretch();
this.mas_Group.sizer.add( masRow4 );

   this.mas_Group.sizer.add( this.masPreview_Check );

   this.mas_Group.sizer.addSpacing( 4 );
   this.mas_Group.sizer.add( this.masSatEnabled_Check );

   var masRow5 = new HorizontalSizer; masRow5.spacing = 6;
   var masSatAmtLabel = new Label( this ); masSatAmtLabel.text = "Saturation Amount:"; masSatAmtLabel.textAlignment = 2 | 8; masSatAmtLabel.setFixedWidth( MAS_LABEL_W );
   masRow5.add( masSatAmtLabel ); masRow5.add( this.masSatAmt_Edit ); masRow5.add( this.masSatAmt_Slider );
   this.mas_Group.sizer.add( masRow5 );

   var masRow6 = new HorizontalSizer; masRow6.spacing = 6;
   var masSatBoostLabel = new Label( this ); masSatBoostLabel.text = "Saturation Boost:"; masSatBoostLabel.textAlignment = 2 | 8; masSatBoostLabel.setFixedWidth( MAS_LABEL_W );
   masRow6.add( masSatBoostLabel ); masRow6.add( this.masSatBoost_Edit ); masRow6.add( this.masSatBoost_Slider );
   this.mas_Group.sizer.add( masRow6 );

   this.mas_Group.sizer.add( this.masSatLM_Check );

   function updateMASControls()
   {
      var master = dlg.masApply_Check.checked;

      dlg.masAgg_Edit.enabled = master;
      dlg.masAgg_Slider.enabled = master;
      dlg.masTbg_Edit.enabled = master;
      dlg.masTbg_Slider.enabled = master;
      dlg.masDRC_Edit.enabled = master;
      dlg.masDRC_Slider.enabled = master;

      dlg.masContrast_Check.enabled = master;
      dlg.masSatEnabled_Check.enabled = master;

      var cr = master && dlg.masContrast_Check.checked;
      dlg.masScale_Combo.enabled = cr;
      dlg.masCRIntensity_Edit.enabled = cr;
      dlg.masCRIntensity_Slider.enabled = cr;
      dlg.masPreview_Check.enabled = cr;

      var sat = master && dlg.masSatEnabled_Check.checked;
      dlg.masSatAmt_Edit.enabled = sat;
      dlg.masSatAmt_Slider.enabled = sat;
      dlg.masSatBoost_Edit.enabled = sat;
      dlg.masSatBoost_Slider.enabled = sat;
      dlg.masSatLM_Check.enabled = sat;
   }

   this.masApply_Check.onCheck = function( checked )
   {
      updateMASControls();
      dlg.adjustToContents();
   };

   this.masContrast_Check.onCheck = function( checked )
   {
      updateMASControls();
   };

   this.masSatEnabled_Check.onCheck = function( checked )
   {
      updateMASControls();
   };

   updateMASControls();

   this.nlNxtApply_Check = new CheckBox( this );
   this.nlNxtApply_Check.text = "Apply Noise Reduction (Nonlinear)";
   this.nlNxtApply_Check.checked = false;

   this.nlNxtDenoise_Edit = new Edit( this );
   this.nlNxtDenoise_Edit.text = "0.30";

   this.nlNxtDenoise_Slider = new Slider( this );
   this.nlNxtDenoise_Slider.minValue = 0;
   this.nlNxtDenoise_Slider.maxValue = 1000;
   this.nlNxtDenoise_Slider.pageSize = 50;
   this.nlNxtDenoise_Slider.tracking = true;
   this.nlNxtDenoise_Slider.setRange( 0, 1000 );
   this.nlNxtDenoise_Slider.value = 300;

   this.nlNxtIterations_Edit = new Edit( this );
   this.nlNxtIterations_Edit.text = "1";
   this.nlNxtIterations_Edit.toolTip = "Allowed values: 1 or 2";

   this.nlNxtHint_Label = new Label( this );
   this.nlNxtHint_Label.text = "Tip: keep nonlinear denoise modest to avoid smearing dust";
   this.nlNxtHint_Label.textColor = 0xFF808080;

   this.nlBxtApply_Check = new CheckBox( this );
   this.nlBxtApply_Check.text = "Apply Sharpening (Nonlinear)";
   this.nlBxtApply_Check.checked = false;

   this.nlBxtSharpenStars_Edit = new Edit( this );
   this.nlBxtSharpenStars_Edit.text = "0.00";

   this.nlBxtAdjustHalos_Edit = new Edit( this );
   this.nlBxtAdjustHalos_Edit.text = "0.00";

   this.nlBxtSharpenNonstellar_Edit = new Edit( this );
   this.nlBxtSharpenNonstellar_Edit.text = "0.25";

   this.nlBxtHint_Label = new Label( this );
   this.nlBxtHint_Label.text = "Tip: keep nonlinear sharpening conservative to avoid artifacts";
   this.nlBxtHint_Label.textColor = 0xFF808080;


   function syncNLDenoiseEditToSlider()
   {
      var v = clamp( dlg.nlNxtDenoise_Edit.text, 0.0, 1.0 );
      dlg.nlNxtDenoise_Slider.value = Math.round( v * 1000 );
      setEditNumber( dlg.nlNxtDenoise_Edit, v, 2 );
   }

   function updateNonlinearControls()
   {
      var nlex = dlg.nlNxtApply_Check.checked;
      dlg.nlNxtDenoise_Edit.enabled = nlex;
      dlg.nlNxtDenoise_Slider.enabled = nlex;
      dlg.nlNxtIterations_Edit.enabled = nlex;
      dlg.nlNxtHint_Label.enabled = nlex;

      var nlsh = dlg.nlBxtApply_Check.checked;
      dlg.nlBxtSharpenStars_Edit.enabled = nlsh;
      dlg.nlBxtAdjustHalos_Edit.enabled = nlsh;
      dlg.nlBxtSharpenNonstellar_Edit.enabled = nlsh;
      dlg.nlBxtHint_Label.enabled = nlsh;
   }

   this.nlNxtApply_Check.onCheck = function( checked )
   {
      updateNonlinearControls();
      dlg.adjustToContents();
   };

   this.nlBxtApply_Check.onCheck = function( checked )
   {
      updateNonlinearControls();
      dlg.adjustToContents();
   };

   this.nlNxtDenoise_Slider.onValueUpdated = function( value )
   {
      var v = value / 1000.0;
      setEditNumber( dlg.nlNxtDenoise_Edit, v, 2 );
   };

   this.nlNxtDenoise_Edit.onEditCompleted = function()
   {
      syncNLDenoiseEditToSlider();
   };

   this.nlNxtIterations_Edit.onEditCompleted = function()
   {
      var it = Math.round( Number( dlg.nlNxtIterations_Edit.text ) );
      if ( isNaN( it ) || (it !== 1 && it !== 2) ) it = 1;
      dlg.nlNxtIterations_Edit.text = "" + it;
   };

   this.nlBxtSharpenStars_Edit.onEditCompleted = function()
   {
      var v = clamp( dlg.nlBxtSharpenStars_Edit.text, 0.0, 0.7 );
      setEditNumber( dlg.nlBxtSharpenStars_Edit, v, 2 );
   };

   this.nlBxtAdjustHalos_Edit.onEditCompleted = function()
   {
      var v = clamp( dlg.nlBxtAdjustHalos_Edit.text, -0.5, 0.5 );
      setEditNumber( dlg.nlBxtAdjustHalos_Edit, v, 2 );
   };

   this.nlBxtSharpenNonstellar_Edit.onEditCompleted = function()
   {
      var v = clamp( dlg.nlBxtSharpenNonstellar_Edit.text, 0.0, 1.0 );
      setEditNumber( dlg.nlBxtSharpenNonstellar_Edit, v, 2 );
   };

   linkEditSlider01( this.nlNxtDenoise_Edit, this.nlNxtDenoise_Slider );

   updateNonlinearControls();

   this.progress_Text = new TextBox( this );
   this.progress_Text.readOnly = true;
   this.progress_Text.setScaledMinHeight( 120 );

   try
   {
      if ( __sbppPrereqOk === true && dlg && dlg.progress_Text )
      {
         var msg = "Pre-requisites verification completed. GraXpert, BXT, NXT and SXT detected. Script can proceed";
         dlg.progress_Text.text += msg + "\n";
         try { Console.writeln( "<end><cbr>" + msg ); } catch ( __e1 ) {}
      }
   }
   catch ( __e ) {}


   this.progress_Bar = new Slider( this );
   this.progress_Bar.minValue = 0;
   this.progress_Bar.maxValue = 1;
   this.progress_Bar.value = 0;
   this.progress_Bar.enabled = false;
   this.progress_Bar.setScaledMinHeight( 18 );

   this.progress_Status = new Label( this );
   this.progress_Status.text = "0%";

   this.updateProgress = function( stepIndex, totalSteps )
   {
      try
      {
         var s = Math.max( 0, Math.min( stepIndex, totalSteps ) );
         var t = Math.max( 1, totalSteps );

         this.progress_Bar.minValue = 0;
         this.progress_Bar.maxValue = 1000;
         this.progress_Bar.value = Math.round( (s / t) * 1000 );

         this.progress_Status.text = "" + Math.round( (s / t) * 100 ) + "%";
      }
      catch ( __e ) {}
   };


   this.ok_Button = new PushButton( this );
   this.ok_Button.text = "RUN WORKFLOW";
   this.ok_Button.setFixedHeight( 60 )
   this.ok_Button.enabled = false;
   this.ok_Button.onClick = function()
   {
      if ( dlg.__isRunning )
         return;

      dlg.__isRunning = true;
      dlg.ok_Button.enabled = false;
      pumpEvents();

      __runStartMS = (new Date).getTime();

      try
      {
         runWorkflow( dlg );
      }
      catch ( e )
      {
         try { Console.criticalln( "<end><cbr>*** Error: " + e.toString() ); } catch ( __e ) {}
         try { if ( dlg && dlg.progress_Text ) dlg.progress_Text.text += "*** Error: " + e.toString() + "\n"; } catch ( __e2 ) {}
      }

      dlg.__isRunning = false;

      try { dlg.updateRunButtonState(); } catch ( __e3 ) { dlg.ok_Button.enabled = true; }
      pumpEvents();
   };

   var main = new VerticalSizer;
   main.margin = 10;
   main.spacing = 8;

   var s1c = new Control( this ); s1c.sizer = new VerticalSizer;
   s1c.sizer.spacing = 4;

   s1c.sizer.add( row2( this, "Mode:", this.mode_Combo, "Output ID:", this.outHelp_Control ) );

   s1c.sizer.add( this.pick_Button );
   s1c.sizer.add( this.detected_Text );

   var statsRow = new HorizontalSizer;
   statsRow.add( this.stats_Panel, 50 );
   statsRow.add( this.legend_Panel, 50 );
   s1c.sizer.add( statsRow );

   var refLbl = new Label( this );
   refLbl.text = "Reference for Linear Fit:";
   refLbl.textAlignment = 0 | 8;
   s1c.sizer.add( refLbl );

   s1c.sizer.add( this.refHigh_Radio );
   s1c.sizer.add( this.refMedium_Radio );
   s1c.sizer.add( this.refHighest_Radio );

   main.add( section( "Step 1: Files", s1c, true ) );

   main.addSpacing( 6 );
   main.add( this.ok_Button );


   var s2c = new Control( this ); s2c.sizer = new VerticalSizer;
   s2c.sizer.spacing = 4;
   s2c.sizer.add( row( this, "Smoothing:", this.bgSmoothing_Edit ) );
   s2c.sizer.add( this.bgHint_Label );
   main.add( section( "Step 2: Background Extraction", s2c, false ) );

   var s3c = new Control( this ); s3c.sizer = new VerticalSizer;
   s3c.sizer.spacing = 4;
   s3c.sizer.add( this.lf_InfoLabel );
   main.add( section( "Step 3: Linear Fit", s3c, true ) );

   var s4c = new Control( this ); s4c.sizer = new VerticalSizer;
   s4c.sizer.spacing = 4;
   s4c.sizer.add( this.psf_InfoLabel );
   main.add( section( "Step 4: PSF Correction", s4c, false ) );

   var s5c = new Control( this ); s5c.sizer = new VerticalSizer;
   s5c.sizer.spacing = 6;

   s5c.sizer.add( row( this, "Palette:", this.palette_Combo ) );

   s5c.sizer.addSpacing( 4 );
   s5c.sizer.add( this.combineCC_Radio );

   s5c.sizer.addSpacing( 4 );
   s5c.sizer.add( this.combinePM_Radio );
   var pmRow = new HorizontalSizer; pmRow.spacing = 6;

   var pmLeft = new VerticalSizer; pmLeft.spacing = 4;
   pmLeft.add( row( this, "R Expr:", this.pmR_Edit ) );
   pmLeft.add( row( this, "G Expr:", this.pmG_Edit ) );
   pmLeft.add( row( this, "B Expr:", this.pmB_Edit ) );

   var pmRight = new VerticalSizer;
   var pmButtons = new HorizontalSizer;
   pmButtons.spacing = 6;
   pmButtons.add( this.pmInit_Button );
   pmButtons.add( this.pmResume_Button );

   pmRight.addStretch();
   pmRight.add( pmButtons );
   pmRight.addStretch();
   pmRow.add( pmLeft );
   pmRow.add( pmRight );
   pmRow.addStretch();

   s5c.sizer.add( pmRow );

   main.add( section( "Step 5: Combination", s5c, true ) );

   var s6c = new Control( this ); s6c.sizer = new VerticalSizer;
   s6c.sizer.spacing = 4;
   s6c.sizer.add( this.spcc_InfoLabel );
   main.add( section( "Step 6: Color Correction", s6c, false ) );

   var s7c = new Control( this ); s7c.sizer = new VerticalSizer;
   s7c.sizer.spacing = 4;

   var nxtRow = new HorizontalSizer; nxtRow.spacing = 6;
   var denL = new Label( this ); denL.text = "Denoise:"; denL.textAlignment = 2 | 8; denL.setFixedWidth( 120 );
   this.nxtDenoise_Edit.setFixedWidth( 60 );
   var itL = new Label( this ); itL.text = "Iterations:"; itL.textAlignment = 2 | 8; itL.setFixedWidth( 110 );
   this.nxtIterations_Edit.setFixedWidth( 40 );

   this.nxtDenoise_Slider.setFixedWidth( 300 );

   nxtRow.add( denL );
   nxtRow.add( this.nxtDenoise_Edit );
   nxtRow.add( this.nxtDenoise_Slider );
   nxtRow.add( itL );
   nxtRow.add( this.nxtIterations_Edit );

   s7c.sizer.add( nxtRow );
   s7c.sizer.add( this.nxtHint_Label );
   main.add( section( "Step 7: Noise Reduction (Linear)", s7c, false ) );

   var s8c = new Control( this ); s8c.sizer = new VerticalSizer;
   s8c.sizer.spacing = 4;
   this.bxtSharpenStars_Edit.setFixedWidth( 120 );
   this.bxtAdjustHalos_Edit.setFixedWidth( 120 );
   this.bxtSharpenNonstellar_Edit.setFixedWidth( 120 );

   var s8r1 = new HorizontalSizer; s8r1.spacing = 6;
   var s8l1 = new Label( this ); s8l1.text = "Sharpen Stars:"; s8l1.textAlignment = 2 | 8; s8l1.setFixedWidth( 180 );
   var s8l2 = new Label( this ); s8l2.text = "Adjust Star Halos:"; s8l2.textAlignment = 2 | 8; s8l2.setFixedWidth( 180 );
   s8r1.add( s8l1 );
   s8r1.add( this.bxtSharpenStars_Edit );
   s8r1.addSpacing( 10 );
   s8r1.add( s8l2 );
   s8r1.add( this.bxtAdjustHalos_Edit );
   s8r1.addStretch();
   s8c.sizer.add( s8r1 );

   var s8r2 = new HorizontalSizer; s8r2.spacing = 6;
   var s8l3 = new Label( this ); s8l3.text = "Sharpen Nonstellar:"; s8l3.textAlignment = 2 | 8; s8l3.setFixedWidth( 180 );
   s8r2.add( s8l3 );
   s8r2.add( this.bxtSharpenNonstellar_Edit );
   s8r2.addStretch();
   s8c.sizer.add( s8r2 );
   s8c.sizer.add( this.bxtHint_Label );
   main.add( section( "Step 8: Sharpening (Linear)", s8c, false ) );

   var s9c = new Control( this ); s9c.sizer = new VerticalSizer;
   s9c.sizer.spacing = 4;

   var sxtRow = new HorizontalSizer; sxtRow.spacing = 14;
   sxtRow.add( this.sxtGenerateStars_Check );
   sxtRow.add( this.sxtUnscreen_Check );
   sxtRow.add( this.sxtLargeOverlap_Check );
   sxtRow.addStretch();
   s9c.sizer.add( sxtRow );
   s9c.sizer.add( this.sxtHint_Label );

   main.add( section( "Step 9: Star Extraction", s9c, false ) );

   var s10c = new Control( this ); s10c.sizer = new VerticalSizer;
   s10c.sizer.spacing = 6;

   s10c.sizer.add( this.ht_Group );

   s10c.sizer.add( this.mas_Group );

   main.add( section( "Step 10: Stretching", s10c, false ) );


   var s11c = new Control( this ); s11c.sizer = new VerticalSizer;
   s11c.sizer.spacing = 4;

   s11c.sizer.add( this.nlNxtApply_Check );

   var s11r1 = new HorizontalSizer; s11r1.spacing = 6;
   var s11l1 = new Label( this ); s11l1.text = "Denoise:"; s11l1.textAlignment = 2 | 8; s11l1.setFixedWidth( 140 );
   this.nlNxtDenoise_Edit.setFixedWidth( 60 );
   s11r1.add( s11l1 );
   s11r1.add( this.nlNxtDenoise_Edit );
   s11r1.add( this.nlNxtDenoise_Slider );
   var s11l2 = new Label( this ); s11l2.text = "Iterations:"; s11l2.textAlignment = 2 | 8; s11l2.setFixedWidth( 90 );
   this.nlNxtIterations_Edit.setFixedWidth( 50 );
   s11r1.addSpacing( 10 );
   s11r1.add( s11l2 );
   s11r1.add( this.nlNxtIterations_Edit );
   s11c.sizer.add( s11r1 );
   s11c.sizer.add( this.nlNxtHint_Label );

   main.add( section( "Step 11: Noise Reduction (Nonlinear)", s11c, false ) );

   var s12c = new Control( this ); s12c.sizer = new VerticalSizer;
   s12c.sizer.spacing = 4;

   s12c.sizer.add( this.nlBxtApply_Check );

   var s12r1 = new HorizontalSizer; s12r1.spacing = 6;
   var s12l1 = new Label( this ); s12l1.text = "Sharpen Stars:"; s12l1.textAlignment = 2 | 8; s12l1.setFixedWidth( 140 );
   this.nlBxtSharpenStars_Edit.setFixedWidth( 80 );
   s12r1.add( s12l1 ); s12r1.add( this.nlBxtSharpenStars_Edit );
   var s12l2 = new Label( this ); s12l2.text = "Adjust Star Halos:"; s12l2.textAlignment = 2 | 8; s12l2.setFixedWidth( 150 );
   this.nlBxtAdjustHalos_Edit.setFixedWidth( 80 );
   s12r1.addSpacing( 10 );
   s12r1.add( s12l2 ); s12r1.add( this.nlBxtAdjustHalos_Edit );
   s12r1.addStretch();
   s12c.sizer.add( s12r1 );

   var s12r2 = new HorizontalSizer; s12r2.spacing = 6;
   var s12l3 = new Label( this ); s12l3.text = "Sharpen Nonstellar:"; s12l3.textAlignment = 2 | 8; s12l3.setFixedWidth( 140 );
   this.nlBxtSharpenNonstellar_Edit.setFixedWidth( 80 );
   s12r2.add( s12l3 ); s12r2.add( this.nlBxtSharpenNonstellar_Edit );
   s12r2.addStretch();
   s12c.sizer.add( s12r2 );

   s12c.sizer.add( this.nlBxtHint_Label );

   main.add( section( "Step 12: Sharpening (Nonlinear)", s12c, false ) );
   var progLabel = new Label( this ); progLabel.text = "Progress";
   main.add( progLabel );

   var progRow = new HorizontalSizer; progRow.spacing = 8;
   progRow.add( this.progress_Bar, 100 );
   progRow.add( this.progress_Status );
   main.add( progRow );

   main.add( this.progress_Text, 100 );

   this.sizer = main;
   this.setMinSize( 970, 900 );

   this.updateRunButtonState = function()
   {
      if ( !this.__userHasSelectedFiles || !this.__statsReady )
      {
         this.ok_Button.enabled = false;
         return;
      }
var n = ( this.files && this.files.length ) ? this.files.length : 0;
      var isSHO = ( this.mode_Combo.currentItem === 0 );
      var isRGB = ( this.mode_Combo.currentItem === 1 );

      if ( isSHO )
         this.ok_Button.enabled = ( n === 2 || n === 3 );
      else if ( isRGB )
         this.ok_Button.enabled = ( n === 3 );
      else
         this.ok_Button.enabled = false;
   };

   this.refreshDetectedUI = function()
   {
      var lines = [];
      var keysFound = [];

      for ( var i = 0; i < this.detected.length; i++ )
      {
         var k = this.detected[i].key || "??";
         lines.push( k + ": " + this.detected[i].file.split(/[\/]/).pop() );

         if ( k && k !== "??" && keysFound.indexOf( k ) < 0 )
            keysFound.push( k );
      }

      this.detected_Text.text = lines.join( "\n" );


      this.updateLinearFitLabel();

      this.updateRunButtonState();
   };

   this.updatePaletteItems = function()
   {
      this.palette_Combo.clear();

      if ( this.mode === "RGB" )
      {
         this.palette_Combo.addItem( "RGB" );
         this.palette_Combo.currentItem = 0;
      }
      else
      {
         this.palette_Combo.addItem( "SHO" );
         this.palette_Combo.addItem( "HSO" );
         this.palette_Combo.addItem( "HOO" );
         this.palette_Combo.currentItem = 0;
      }


      try { this.applyPixelMathDefaultsForce(); } catch ( __e ) {}

   };


   this.updateCombinationControls = function()
   {
      var useCC = ( dlg.combineCC_Radio && dlg.combineCC_Radio.checked );
      var usePM = ( dlg.combinePM_Radio && dlg.combinePM_Radio.checked );

      if ( dlg.palette_Combo )
         dlg.palette_Combo.enabled = true;

      if ( dlg.pmR_Edit ) dlg.pmR_Edit.enabled = usePM;
      if ( dlg.pmG_Edit ) dlg.pmG_Edit.enabled = usePM;
      if ( dlg.pmB_Edit ) dlg.pmB_Edit.enabled = usePM;
   };

   this.applyPixelMathDefaultsIfEmpty = function()
   {
      var isRGB = ( dlg.mode === "RGB" );
      var defR = isRGB ? "R" : "Sii";
      var defG = isRGB ? "G" : "Ha";
      var defB = isRGB ? "B" : "Oiii";

      function isEmpty( s )
      {
         return (s == null) || (String(s).trim().length < 1);
      }

      if ( dlg.pmR_Edit && isEmpty( dlg.pmR_Edit.text ) )
         dlg.pmR_Edit.text = defR;

      if ( dlg.pmG_Edit && isEmpty( dlg.pmG_Edit.text ) )
         dlg.pmG_Edit.text = defG;

      if ( dlg.pmB_Edit && isEmpty( dlg.pmB_Edit.text ) )
         dlg.pmB_Edit.text = defB;
   };

   this.applyPixelMathDefaultsForce = function()
   {
      var modeLabel = ( dlg.mode === "RGB" ) ? "RGB" : "SHO";
      var paletteText = __paletteTextSafe( dlg );
      var map = __paletteMapping( modeLabel, paletteText );

      var defR = map.R;
      var defG = map.G;
      var defB = map.B;

      if ( dlg.pmR_Edit ) dlg.pmR_Edit.text = defR;
      if ( dlg.pmG_Edit ) dlg.pmG_Edit.text = defG;
      if ( dlg.pmB_Edit ) dlg.pmB_Edit.text = defB;
   };

   if ( dlg.pmInit_Button )
      dlg.pmInit_Button.onClick = function()
      {
         dlg.applyPixelMathDefaultsForce();
      };



   dlg._pmResumeRequested = false;
   this.waitForPixelMathResume = function()
   {
      dlg._pmResumeRequested = false;
      if ( dlg.pmResume_Button )
         dlg.pmResume_Button.enabled = true;

      while ( !dlg._pmResumeRequested )
         pauseMs( 100 );

      if ( dlg.pmResume_Button )
         dlg.pmResume_Button.enabled = false;
   };

   if ( dlg.pmResume_Button )
      dlg.pmResume_Button.onClick = function()
      {
         dlg._pmResumeRequested = true;
      };
   this.getReferencePolicyId = function()
   {
      if ( this.refHighest_Radio && this.refHighest_Radio.checked ) return 2;
      if ( this.refMedium_Radio && this.refMedium_Radio.checked ) return 1;
      return 0;
   };

   this.setReferencePolicyId = function( id )
   {
      id = Math.round( Number( id ) );
      if ( !isFinite( id ) ) id = 2;
      if ( id < 0 ) id = 0;
      if ( id > 2 ) id = 2;

      if ( this.refHigh_Radio )     this.refHigh_Radio.checked = (id === 0);
      if ( this.refMedium_Radio )   this.refMedium_Radio.checked = (id === 1);
      if ( this.refHighest_Radio )  this.refHighest_Radio.checked = (id === 2);

      if ( this.refHigh_Radio && this.refMedium_Radio && this.refHighest_Radio )
      {
         if ( !this.refHigh_Radio.checked && !this.refMedium_Radio.checked && !this.refHighest_Radio.checked )
            this.refHighest_Radio.checked = true;
      }

      try { this.updateLinearFitLabel(); } catch ( __e ) {}
   };


   
   this.getReferencePolicyLabel = function()
   {
      var id = this.getReferencePolicyId();
      return (id === 2) ? "Use highest signal (Mean minus Median)" :
             (id === 1) ? "Use medium signal (Mean minus Median)" :
                          "Use lowest signal (Mean minus Median)";
   };

   this._formatRefStatText = function( st )
   {
      if ( !st ) return "";
      function f6( x ) { try { return format( "%.6f", x ); } catch ( __e ) { return "" + x; } }
      var id = st.id ? st.id : "";
      return id + " (Δ " + f6( st.delta ) + ", μ " + f6( st.mean ) + ", m " + f6( st.median ) + ")";
   };

   this.updateLinearFitLabel = function()
   {
      var id = this.getReferencePolicyId();

      if ( this.__refPreview && typeof this.__refPreview === "object" )
      {
         var st = (id === 2) ? this.__refPreview.highest :
                  (id === 1) ? this.__refPreview.medium  :
                               this.__refPreview.lowest;
         if ( st )
         {
            setLabelText( this.lf_InfoLabel, "LinearFit reference: " + this.getReferencePolicyLabel() + " ( " + this._formatRefStatText( st ) + " )" );
            return;
         }
      }

      setLabelText( this.lf_InfoLabel, "LinearFit reference: " + this.getReferencePolicyLabel() );
   };

   this.computeMeanMedianDelta = function( view )
   {
      var r = { mean: NaN, median: NaN, delta: NaN };
      if ( view == null || view.isNull ) return r;

      try
      {
         var st = getRobustViewStats( view );
         r.mean = Number( st.mean );
         r.median = Number( st.median );
         r.delta = r.mean - r.median;
         return r;
      }
      catch ( __e ) {}

      try
      {
         var S = new ImageStatistics( view.image );
         r.mean = Number( S.mean );
         r.median = Number( S.median );
         r.delta = r.mean - r.median;
      }
      catch ( __e2 ) {}

      return r;
   };

   this.updateReferencePreviewFromFiles = function()
   {
      this.__refPreview = null;

      

      this.__statsReady = false;
      this.updateRunButtonState();
if ( !this.files || this.files.length < 1 )
      {
         if ( this.refHigh_Radio )    this.refHigh_Radio.text    = "Use lowest signal value";
         if ( this.refMedium_Radio )  this.refMedium_Radio.text  = "Use medium signal value";
         if ( this.refHighest_Radio ) this.refHighest_Radio.text = "Use highest signal value";
         try { if ( this.stats_Label ) this.stats_Label.text = ""; } catch ( __e0 ) {}
          try { if ( this.legend_Label ) this.legend_Label.text = ""; } catch ( __e0L ) {}
         this.updateLinearFitLabel();
         return;
      }

      var statsByKey = {};
      for ( var i = 0; i < this.detected.length; ++i )
      {
         var k = this.detected[i].key;
         var f = this.detected[i].file;
         if ( !k || k === "??" ) continue;
         if ( statsByKey[k] ) continue;

         try
         {
            var w = ImageWindow.open( f );
            if ( w && w.length > 0 )
            {
               var win = w[0];
               var st = this.computeMeanMedianDelta( win.mainView );
               st.id = k;
               if ( isFinite( st.delta ) )
                  statsByKey[k] = st;
               try { win.close(); } catch ( __eClose ) {}
            }
         }
         catch ( __eOpen ) {}
      }

      var isSHO = ( this.mode_Combo.currentItem === 0 );
      var wanted = isSHO ? [ "Sii", "Ha", "Oiii" ] : [ "R", "G", "B" ];

      try
      {
         if ( this.stats_Label )
         {
            var lines = [];

            lines.push( "          Δ          μ          m" );

            function fmtRow( id, st )
            {
               return format( "%-4s %10.6f %10.6f %10.6f", id, st.delta, st.mean, st.median );
            }

            for ( var wi2 = 0; wi2 < wanted.length; ++wi2 )
            {
               var k2 = wanted[wi2];
               if ( statsByKey[k2] )
                  lines.push( fmtRow( k2, statsByKey[k2] ) );
               else
                  lines.push( format( "%-4s %10s %10s %10s", k2, "n/a", "n/a", "n/a" ) );
            }

            this.stats_Label.text = lines.join( "\n" );
            if ( this.legend_Label ) this.legend_Label.text = "\nΔ  Mean - Median\nμ  Mean\nm  Median";
         }
      }
      catch ( __eStatsUI ) {}

      var arr = [];
      for ( var wi = 0; wi < wanted.length; ++wi )
      {
         var kk = wanted[wi];
         if ( statsByKey[kk] && isFinite( statsByKey[kk].delta ) )
            arr.push( statsByKey[kk] );
      }

      if ( arr.length < 1 )
      {
         if ( this.refHigh_Radio )    this.refHigh_Radio.text    = "Use lowest signal value";
         if ( this.refMedium_Radio )  this.refMedium_Radio.text  = "Use medium signal value";
         if ( this.refHighest_Radio ) this.refHighest_Radio.text = "Use highest signal value";
         try { if ( this.stats_Label ) this.stats_Label.text = ""; } catch ( __e0b ) {}
          try { if ( this.legend_Label ) this.legend_Label.text = ""; } catch ( __e0bL ) {}
         this.updateLinearFitLabel();
         return;
      }

      arr.sort( function( a, b ) { return a.delta - b.delta; } );

      var n = arr.length;
      var lowest  = arr[0];
      var highest = arr[n-1];
      var medium  = arr[Math.floor((n-1)/2)];

      this.__refPreview = { lowest: lowest, medium: medium, highest: highest };

      if ( this.refHigh_Radio )    this.refHigh_Radio.text    = "Use lowest signal value ( "  + this._formatRefStatText( lowest )  + " )";
      if ( this.refMedium_Radio )  this.refMedium_Radio.text  = "Use medium signal value ( "  + this._formatRefStatText( medium )  + " )";
      if ( this.refHighest_Radio ) this.refHighest_Radio.text = "Use highest signal value ( " + this._formatRefStatText( highest ) + " )";

      this.__statsReady = true;
      this.updateRunButtonState();

      this.updateLinearFitLabel();
   };
   this.setProgress = function( current, total, caption )
   {
      if ( total == null || total < 1 ) total = 1;
      if ( current == null ) current = 0;
      current = Math.max( 0, Math.min( current, total ) );

      this.progress_Bar.minValue = 0;
      this.progress_Bar.maxValue = total;
      this.progress_Bar.value = current;

      var pct = Math.round( (current * 100) / total );
      var msg = (caption && caption.length) ? (" (" + caption + ")") : "";
      this.progress_Status.text = pct + "%  " + current + "/" + total + msg;
      pumpEvents();
   };

this.mode_Combo.onItemSelected = function( i )
   {
      dlg.mode = ( i === 1 ) ? "RGB" : "SHO";
      dlg.refreshDetectedUI();
      dlg.updatePaletteItems();
      dlg.updateCombinationControls();
      try { dlg.updateReferencePreviewFromFiles(); } catch ( __e ) {}
      dlg.applyPixelMathDefaultsIfEmpty();
   };

   dlg.__lastPaletteText = __paletteTextSafe( dlg );
   dlg.__inPaletteRemap = false;

   dlg.remapPixelMathExpressionsForPaletteChange = function( newPaletteText )
   {
      try
      {
         var modeLabel = ( dlg.mode === "RGB" ) ? "RGB" : "SHO";

         var oldPaletteText = ( dlg.__lastPaletteText && String( dlg.__lastPaletteText ).length ) ? String( dlg.__lastPaletteText ) : __paletteTextSafe( dlg );
         var newPal = ( newPaletteText && String( newPaletteText ).length ) ? String( newPaletteText ) : __paletteTextSafe( dlg );

         var oldMap = __paletteMapping( modeLabel, oldPaletteText );
         var newMap = __paletteMapping( modeLabel, newPal );

         var cur = {
            R: ( dlg.pmR_Edit ? String( dlg.pmR_Edit.text || "" ) : "" ),
            G: ( dlg.pmG_Edit ? String( dlg.pmG_Edit.text || "" ) : "" ),
            B: ( dlg.pmB_Edit ? String( dlg.pmB_Edit.text || "" ) : "" )
         };

         var logical = {};
         function setLogical( ch, expr )
         {
            if ( !ch ) return;
            expr = ( expr === undefined || expr === null ) ? "" : String( expr );

            if ( logical[ch] === undefined || String( logical[ch] ).length === 0 )
               logical[ch] = expr;
            else if ( String( logical[ch] ).length === 0 && expr.length > 0 )
               logical[ch] = expr;
         }

         setLogical( oldMap.R, cur.R );
         setLogical( oldMap.G, cur.G );
         setLogical( oldMap.B, cur.B );

         function exprFor( ch )
         {
            if ( logical[ch] !== undefined )
               return String( logical[ch] );
            return String( ch || "" );
         }

         if ( dlg.pmR_Edit ) dlg.pmR_Edit.text = exprFor( newMap.R );
         if ( dlg.pmG_Edit ) dlg.pmG_Edit.text = exprFor( newMap.G );
         if ( dlg.pmB_Edit ) dlg.pmB_Edit.text = exprFor( newMap.B );

         dlg.__lastPaletteText = newPal;
      }
      catch ( __e )
      {
      }
   };

   if ( dlg.palette_Combo )
      dlg.palette_Combo.onItemSelected = function( i )
      {
         if ( dlg.__inPaletteRemap )
            return;

         dlg.__inPaletteRemap = true;
         try
         {
            var newText = __paletteTextSafe( dlg );
            dlg.remapPixelMathExpressionsForPaletteChange( newText );
         }
         finally
         {
            dlg.__inPaletteRemap = false;
         }
      };


   this.refHigh_Radio.onCheck = function( checked ){ if ( checked ) dlg.updateLinearFitLabel(); };
   this.refMedium_Radio.onCheck = function( checked ){ if ( checked ) dlg.updateLinearFitLabel(); };
   this.refHighest_Radio.onCheck = function( checked ){ if ( checked ) dlg.updateLinearFitLabel(); };

   this.combineCC_Radio.onCheck = function( checked )
   {
      if ( checked )
      {
         dlg.combinePM_Radio.checked = false;
         dlg.updatePaletteItems();
         dlg.updateCombinationControls();
         dlg.applyPixelMathDefaultsIfEmpty();
      }
   };

   this.combinePM_Radio.onCheck = function( checked )
   {
      if ( checked )
      {
         dlg.combineCC_Radio.checked = false;
         dlg.updatePaletteItems();
         dlg.updateCombinationControls();
         dlg.applyPixelMathDefaultsIfEmpty();
      }
   };

   this.pick_Button.onClick = function()
   {
      var fd = new OpenFileDialog;
      fd.multipleSelections = true;


      var isSHO = ( dlg.mode_Combo.currentItem === 0 );
      var filters = [];

      if ( dlg.mode_Combo.currentItem == 0 )
      {
         filters.push( [ "SHO Masters (Ha, Sii, Oiii)", "*Ha*.* *HA*.* *Sii*.* *SII*.* *Oiii*.* *OIII*.*" ] );
         filters.push( [ "Ha Masters", "*Ha*.* *HA*.*" ] );
         filters.push( [ "Sii Masters", "*Sii*.* *SII*.*" ] );
         filters.push( [ "Oiii Masters", "*Oiii*.* *OIII*.*" ] );
      }
      else
      {
         filters.push( [ "RGB Masters (R, G, B)", "*_R*.* *_G*.* *_B*.* *Red*.* *Green*.* *Blue*.*" ] );
         filters.push( [ "Red / R Masters", "*_R*.* *Red*.*" ] );
         filters.push( [ "Green / G Masters", "*_G*.* *Green*.*" ] );
         filters.push( [ "Blue / B Masters", "*_B*.* *Blue*.*" ] );
      }

      filters.push( [ "All Files", "*" ] );

      fd.filters = filters;

if ( fd.execute() )
      {
         dlg.files = fd.fileNames;
         
         dlg.__userHasSelectedFiles = true;
         dlg.__statsReady = false;
         dlg.updateRunButtonState();
dlg.detected = [];

         for ( var i = 0; i < dlg.files.length; i++ )
            dlg.detected.push( { file: dlg.files[i], key: guessKeyFromFilename( dlg.files[i] ) } );

         dlg.refreshDetectedUI();
         dlg.updatePaletteItems();
         try { dlg.updateReferencePreviewFromFiles(); } catch ( __e ) {}
      }
   };


   function syncDenoiseEditToSlider()
   {
      var v = clamp( dlg.nxtDenoise_Edit.text, 0.0, 1.0 );
      dlg.nxtDenoise_Slider.value = Math.round( v * 1000 );
      setEditNumber( dlg.nxtDenoise_Edit, v, 2 );
   }

   function syncDenoiseSliderToEdit()
   {
      var v = dlg.nxtDenoise_Slider.value / 1000.0;
      v = clamp( v, 0.0, 1.0 );
      setEditNumber( dlg.nxtDenoise_Edit, v, 2 );
   }

   this.nxtDenoise_Edit.onEditCompleted = function()
   {
      syncDenoiseEditToSlider();
   };

   this.nxtDenoise_Slider.onValueUpdated = function( value )
   {
      syncDenoiseSliderToEdit();
   };

   
   this.bgSmoothing_Edit.onEditCompleted = function()
   {
      var v = clamp( dlg.bgSmoothing_Edit.text, 0.0, 1.0 );
      setEditNumber( dlg.bgSmoothing_Edit, v, 2 );
   };

   this.nxtIterations_Edit.onEditCompleted = function()
   {
      var it = Math.round( Number( dlg.nxtIterations_Edit.text ) );
      if ( isNaN( it ) || (it !== 1 && it !== 2) ) it = 1;
      dlg.nxtIterations_Edit.text = "" + it;
   };

   this.bxtSharpenStars_Edit.onEditCompleted = function()
   {
      var v = clamp( dlg.bxtSharpenStars_Edit.text, 0.0, 0.7 );
      setEditNumber( dlg.bxtSharpenStars_Edit, v, 2 );
   };

   this.bxtAdjustHalos_Edit.onEditCompleted = function()
   {
      var v = clamp( dlg.bxtAdjustHalos_Edit.text, -0.5, 0.5 );
      setEditNumber( dlg.bxtAdjustHalos_Edit, v, 2 );
   };

   this.bxtSharpenNonstellar_Edit.onEditCompleted = function()
   {
      var v = clamp( dlg.bxtSharpenNonstellar_Edit.text, 0.0, 1.0 );
      setEditNumber( dlg.bxtSharpenNonstellar_Edit, v, 2 );
   };

   sbppTryLoadLastConfiguration( dlg );

   try { dlg.setReferencePolicyId( dlg.getReferencePolicyId() ); } catch ( __e ) { try { dlg.setReferencePolicyId( 2 ); } catch ( __e2 ) {} }

   this.applyPixelMathDefaultsIfEmpty();

   this.refreshDetectedUI();
   this.updatePaletteItems();
   this.updateCombinationControls();
   this.updateLinearFitLabel();
   syncDenoiseEditToSlider();
   syncNLDenoiseEditToSlider();
   updateMASControls();
   updateNonlinearControls();
   this.updateRunButtonState();
}
WorkflowDialog.prototype = new Dialog;



function formatElapsedMMSS( elapsedMs )
{
   if ( elapsedMs < 0 )
      elapsedMs = 0;

   var totalSeconds = Math.floor( elapsedMs / 1000 );
   var minutes = Math.floor( totalSeconds / 60 );
   var seconds = totalSeconds % 60;

   var mm = ( minutes < 10 ? "0" : "" ) + minutes;
   var ss = ( seconds < 10 ? "0" : "" ) + seconds;

   return mm + ":" + ss;
}

function runWorkflow( dlg )
{
   Console.show();
   dlg.progress_Text.text = "";

   function log( s )
   {
      Console.writeln( "<end><cbr>" + s );
      dlg.progress_Text.text += s + "\n";
      pumpEvents();
   }

   var __totalSteps = 12;


   function beginStep( n, title )
{
   __stepIndex = n;
   log( "" );
   log( "Step " + n + "/" + __totalSteps + ": " + title );
   try { if ( typeof dlg.updateProgress === "function" ) dlg.updateProgress( n, __totalSteps ); } catch ( __e ) {}
}


   function logSub( s )
{
   try { log( "   " + s ); } catch ( __e ) {}
}


   function endStep( note )
{
   if ( note && note.length )
      log( note );

   try { if ( typeof dlg.updateProgress === "function" ) dlg.updateProgress( __stepIndex, __totalSteps ); } catch ( __e ) {}
}
log( "Run started" );

   tick( "Start" );
   if ( !dlg.detected || dlg.detected.length < 1 )
      throw new Error( "No files selected. Use Select Master Files first." );

   var keys = ( dlg.mode === "RGB" ) ? ["R","G","B"] : ["Ha","Sii","Oiii"];

   var present = {};
   for ( var pd = 0; pd < dlg.detected.length; ++pd )
   {
      var dk = dlg.detected[pd].key;
      if ( dk && dk.length ) present[dk] = true;
   }

   var presentKeys = [];
   for ( var pk = 0; pk < keys.length; ++pk )
      if ( present[keys[pk]] ) presentKeys.push( keys[pk] );

   if ( presentKeys.length < 1 )
      presentKeys = keys;

   function computeTotalProgressSteps()
   {
      var t = 0;
      t += 1;
      t += presentKeys.length;
      t += presentKeys.length;
      t += presentKeys.length;
      t += presentKeys.length;
      t += Math.max( 0, presentKeys.length - 1 );
      t += 1;
      t += presentKeys.length;
      t += 1;
      t += 1;
      t += 1;
      t += 1;
      t += 1;
      if ( dlg.stretch_Check && dlg.stretch_Check.checked )
         t += 1;
      if ( dlg.masApply_Check && dlg.masApply_Check.checked )
         t += 1;
      var __nStretch = 0;
      if ( dlg.stretch_Check && dlg.stretch_Check.checked ) __nStretch += 1;
      if ( dlg.masApply_Check && dlg.masApply_Check.checked ) __nStretch += 1;

      if ( dlg.nlNxtApply_Check && dlg.nlNxtApply_Check.checked )
         t += __nStretch;

      if ( dlg.nlBxtApply_Check && dlg.nlBxtApply_Check.checked )
         t += __nStretch;
      t += 1;
      return t;
   }

   var totalSteps = computeTotalProgressSteps();

   __progress = {
      current: 0,
      total: totalSteps,
      advance: function( caption )
      {
         this.current = Math.min( this.current + 1, this.total );
         if ( typeof dlg.setProgress === "function" )
            dlg.setProgress( this.current, this.total, caption || "" );
      },
      done: function()
      {
         this.current = this.total;
         if ( typeof dlg.setProgress === "function" )
            dlg.setProgress( this.total, this.total, "Done" );
      }
   };

   if ( typeof dlg.setProgress === "function" )
      dlg.setProgress( 0, totalSteps, "" );

   function tick( caption )
   {
      if ( __progress )
         __progress.advance( caption );
   }


   var viewsByKey = {};

   beginStep( 1, "Files" );

   for ( var i = 0; i < dlg.detected.length; i++ )
   {
      var filePath = dlg.detected[i].file;
      var key = dlg.detected[i].key;

      if ( !key || key.length < 1 )
      {
         log( "Skipping (unknown channel): " + filePath.split(/[\\/]/).pop() );
         continue;
      }

      log( "Opening " + key + ": " + filePath );
      var win = openImage( filePath );

      log( "Setting identifier to " + key );
      renameMainViewTo( win.mainView, key );

      win.show();
      ImageWindow.activeWindow = win;
      win.bringToFront();
      pumpEvents();

      viewsByKey[key] = win.mainView;
      tick( "Loaded " + key );
   }

   logSub( "Applying STF (visual) to loaded images" );

   for ( var k = 0; k < keys.length; k++ )
   {
      var id = keys[k];
      var v = viewsByKey[id];

      if ( v && !v.isNull )
      {
         log( "Applying STF to " + id );
         applyVisualSTF( v );
         tick( "STF " + id );
      }
      else
      {
         log( "No view found for " + id + " (skipping STF)" );
      }
   }

   logSub( "Calculating statistics for reference selection" );

   var bestId = "";
   var bestMean = -1;

   for ( var m = 0; m < keys.length; m++ )
   {
      var mid = keys[m];
      var mv = viewsByKey[mid];

      if ( mv && !mv.isNull )
      {
         var meanVal = calculateMean( mid );
         log( "Mean " + mid + " = " + meanVal );

         tick( "Mean " + mid );
         if ( meanVal > bestMean )
         {
            bestMean = meanVal;
            bestId = mid;
         }
      }
   }

   if ( bestId.length )
   {
      dlg.__suggestedReferenceId = bestId;
      dlg.__suggestedReferenceMean = bestMean;
      log( "Suggested Reference (highest mean): " + bestId + " (mean=" + bestMean + ")" );
   }
   else
   {
      log( "No valid views found to compute mean. Reference policy will still apply later." );
   }

   beginStep( 2, "Background Extraction" );

   var gx = new GraXpert;
   gx.backgroundExtraction = true;
   gx.smoothing = Number( dlg.bgSmoothing_Edit.text );
   if ( isNaN( gx.smoothing ) ) gx.smoothing = 0.5;
   gx.smoothing = Math.range( gx.smoothing, 0.0, 1.0 );

   gx.correction = "Subtraction";

   gx.createBackground = false;
   gx.backgroundExtractionAIModel = "";
   gx.denoising = false;
   gx.strength = 1.00;
   gx.batchSize = 4;
   gx.denoiseAIModel = "2.0.0";
   gx.disableGPU = false;
   gx.replaceImage = true;
   gx.showLogs = false;
   gx.appPath = "";
   gx.deconvolution = false;
   gx.deconvolutionMode = "Object-only";
   gx.deconvolutionObjectStrength = 0.5;
   gx.deconvolutionObjectPSFSize = 5.0;
   gx.deconvolutionObjectAIModel = "";
   gx.deconvolutionStarsAIModel = "";

   var viewsG = {};

   for ( var g = 0; g < keys.length; g++ )
   {
      var cid = keys[g];
      var inView = viewsByKey[cid];

      if ( !inView || inView.isNull )
      {
         log( "GraXpert skipped (missing view): " + cid );
         continue;
      }

      log( "GraXpert applying to: " + cid );
      gx.executeOn( inView );

      processEvents();

      var outId = cid + "_g";
      log( "Renaming GraXpert result to " + outId );

      var outWin = inView.window;
      renameMainViewTo( outWin.mainView, outId );

      outWin.show();
      outWin.bringToFront();

      applyVisualSTF( outWin.mainView );

      viewsG[cid] = outWin.mainView;
		tick( "GraXpert " + cid );
   }

   logSub( "GraXpert completed." );

   beginStep( 3, "Linear Fit" );

   
   function chooseReferenceBaseId( keys, policyId )
   {
      var arr = [];
      for ( var i = 0; i < keys.length; ++i )
      {
         var k = keys[i];
         var gid = k + "_g";
         var win = ImageWindow.windowById( gid );
         if ( win == null || win.isNull )
            continue;

         try
         {
            var st = getRobustViewStats( win.mainView );
            var mean = Number( st.mean );
            var median = Number( st.median );
            var delta = mean - median;

            log( "Stats for " + gid + ": mean " + format( "%.6f", mean ) + "  median " + format( "%.6f", median ) + "  delta " + format( "%.6f", delta ) );

            if ( isFinite( delta ) )
               arr.push( { id: k, mean: mean, median: median, delta: delta } );
         }
         catch ( __e ) {}
      }

      if ( arr.length < 1 )
         return keys.length ? keys[0] : "";

      arr.sort( function( a, b ) { return a.delta - b.delta; } );

      var n = arr.length;
      var idxLowest = 0;
      var idxMedium = Math.floor( (n - 1) / 2 );
      var idxHighest = n - 1;

      var idx = (policyId === 2) ? idxHighest : (policyId === 1) ? idxMedium : idxLowest;
      idx = Math.max( 0, Math.min( idx, n - 1 ) );

      return arr[idx].id;
   }

   var refPolicyId = ( dlg.getReferencePolicyId ? dlg.getReferencePolicyId() : 2 );
   var refBase = chooseReferenceBaseId( keys, refPolicyId );
   var refGId = refBase + "_g";
var refGWin = ImageWindow.windowById( refGId );
   if ( refGWin == null || refGWin.isNull )
      throw new Error( "Reference _g view not found: " + refGId );

   log( "LinearFit reference: " + refGId );

   try
   {
      var __st = new ImageStatistics( refGWin.mainView.image );
      var __mean6 = format( "%.6f", __st.mean );
      setLabelText( dlg.lf_InfoLabel, "LinearFit using " + refGId + " as Reference with mean " + __mean6 );
   }
   catch ( __e )
   {
      setLabelText( dlg.lf_InfoLabel, "LinearFit using " + refGId + " as Reference" );
   }

   var __preLinearFitStats = {};
   for ( var s = 0; s < keys.length; ++s )
   {
      var sid = keys[s];
      var vid = sid + "_g";
      var win = ImageWindow.windowById( vid );
      if ( win == null || win.isNull )
      {
         log( "Stats skipped (missing): " + vid );
         continue;
      }

      __preLinearFitStats[sid] = getRobustViewStats( win.mainView );
      try
      {
         var st = __preLinearFitStats[sid];
         log( "Stats (pre LF) " + sid + ": strength=" + format("%.6f", st.strength) +
              "  madSigma=" + format("%.6f", st.madSigma) + "  stdDev=" + format("%.6f", st.stdDev) );
      }
      catch ( __e ) {}
   }


   for ( var lf = 0; lf < keys.length; lf++ )
   {
      var baseId = keys[lf];
      if ( baseId === refBase )
         continue;

      var targetGId = baseId + "_g";
      var targetGWin = ImageWindow.windowById( targetGId );

      if ( targetGWin == null || targetGWin.isNull )
      {
         log( "LinearFit skipped (missing): " + targetGId );
         continue;
      }

      log( "LinearFit: " + targetGId + " -> " + refGId );
      linearFitToID( refGId, targetGId, log );

      var lfId = targetGId + "_lf";
      log( "Renaming LinearFit result to " + lfId );
      renameMainViewTo( targetGWin.mainView, lfId );

      log( "Applying STF to " + lfId + " (post LinearFit)" );
      applyVisualSTF( targetGWin.mainView );
		tick( "LinearFit " + baseId );
   }

   var refLfId = refGId + "_lf";
   log( "Renaming reference to " + refLfId + " (reference not altered)" );
   renameMainViewTo( refGWin.mainView, refLfId );

	tick( "LinearFit reference renamed" );
   log( "LinearFit applied to all images" );

   beginStep( 4, "PSF Correction" );

   var bxt = new BlurXTerminator;
   bxt.ai_file = "BlurXTerminator.4.pb";
   bxt.correct_only = true;
   bxt.correct_first = false;
   bxt.nonstellar_then_stellar = false;
   bxt.lum_only = false;
   bxt.sharpen_stars = 0.00;
   bxt.adjust_halos = 0.00;
   bxt.nonstellar_psf_diameter = 0.00;
   bxt.auto_nonstellar_psf = true;
   bxt.sharpen_nonstellar = 0.50;

   for ( var b = 0; b < keys.length; b++ )
   {
      var baseId = keys[b];
      var inId = baseId + "_g_lf";

      var inWin = ImageWindow.windowById( inId );
      if ( inWin == null || inWin.isNull )
      {
         log( "BXT skipped (missing): " + inId );
         continue;
      }

      log( "BXT PSF (Correct Only) applying to " + inId );
      bxt.executeOn( inWin.mainView );

      pauseMs( 500 );

      var outId = baseId;
      log( "Renaming BXT result to canonical id: " + outId );
      renameMainViewTo( inWin.mainView, outId );

      log( "Applying STF to " + outId + " (post BXT)" );
      applyVisualSTF( inWin.mainView );
		tick( "BXTco " + baseId );
   }

   log( "BXT PSF completed. Outputs renamed to canonical ids (Ha, Sii, Oiii, R, G, B)" );


var __modeLabel = "";
if ( dlg.mode_Combo )
   __modeLabel = dlg.mode_Combo.itemText( dlg.mode_Combo.currentItem );

var __mode = __normalizeModeLabel( __modeLabel );
var __paletteText = __paletteTextSafe( dlg );
var __map = __paletteMapping( __mode, __paletteText );
var __suggested = suggestPixelMathExpressionsFromStats( __map, __preLinearFitStats );

function __trim( s )
{
   return ("" + s).replace(/^\s+|\s+$/g, "");
}

function __defaultFor( which )
{
   return (which === "R") ? __map.R : (which === "G") ? __map.G : __map.B;
}

function __shouldAutofill( currentText, which )
{
   var t = __trim( currentText );
   if ( t.length === 0 )
      return true;
   return t === __defaultFor( which );
}

if ( dlg.pmR_Edit && __shouldAutofill( dlg.pmR_Edit.text, "R" ) )
   dlg.pmR_Edit.text = __suggested.R;

if ( dlg.pmG_Edit && __shouldAutofill( dlg.pmG_Edit.text, "G" ) )
   dlg.pmG_Edit.text = __suggested.G;

if ( dlg.pmB_Edit && __shouldAutofill( dlg.pmB_Edit.text, "B" ) )
   dlg.pmB_Edit.text = __suggested.B;

log( "PixelMath suggestion (" + (__modeLabel.length ? __modeLabel : __mode) + "): R=" + __suggested.R + "  G=" + __suggested.G + "  B=" + __suggested.B );



   
beginStep( 5, "Combination" );

   function requireWin( id )
   {
      var w = ImageWindow.windowById( id );
      if ( w == null || w.isNull )
         throw new Error( "Missing required view: " + id );
      return w;
   }


   function copyAstrometricMetadata( srcWin, dstWin )
{
   if ( srcWin == null || srcWin.isNull || dstWin == null || dstWin.isNull )
      return false;

   if ( !srcWin.hasAstrometricSolution )
      return false;

   dstWin.copyAstrometricSolution( srcWin );
   return true;
}


   var suffix = "";

   var rId, gId, bId;

   if ( dlg.mode === "RGB" )
   {
      rId = firstExistingId( [ "R", "Red" ] );
      gId = firstExistingId( [ "G", "Green" ] );
      bId = firstExistingId( [ "B", "Blue" ] );

      if ( rId == null || gId == null || bId == null )
         throw new Error( "RGB mode requires R/G/B (or Red/Green/Blue) views." );
   }
   else
   {
      var __ptext = "SHO";
      try { if ( dlg.palette_Combo ) __ptext = dlg.palette_Combo.itemText( dlg.palette_Combo.currentItem ); } catch ( __e ) {}
      var __m = __paletteMapping( "SHO", __ptext );
      rId = __m.R + suffix;
      gId = __m.G + suffix;
      bId = __m.B + suffix;
   }

   requireWin( rId );
   requireWin( gId );
   requireWin( bId );

   var outId = ( dlg.out_Edit.text || "" ).trim();
   if ( outId.length === 0 )
      outId = "RGB";

   var usePixelMath = ( dlg.combinePM_Radio && dlg.combinePM_Radio.checked );

   if ( usePixelMath )
   {

      log( "ACCEPT/MODIFY SUGGESTED Expr VALUES. HIT Resume TO CONTINUE... " );
      if ( dlg.waitForPixelMathResume )
         dlg.waitForPixelMathResume();

      var exprR = ( dlg.pmR_Edit ? String( dlg.pmR_Edit.text ).trim() : "" );
      var exprG = ( dlg.pmG_Edit ? String( dlg.pmG_Edit.text ).trim() : "" );
      var exprB = ( dlg.pmB_Edit ? String( dlg.pmB_Edit.text ).trim() : "" );

      if ( exprR.length === 0 ) exprR = rId;
      if ( exprG.length === 0 ) exprG = gId;
      if ( exprB.length === 0 ) exprB = bId;

      log( "Combining using PixelMath expressions" );
      log( "R Expr = " + exprR );
      log( "G Expr = " + exprG );
      log( "B Expr = " + exprB );
      log( "Creating combined image: " + outId );

      var P = new PixelMath;
      P.expression  = exprR;
      P.expression1 = exprG;
      P.expression2 = exprB;
      P.expression3 = "";
      P.useSingleExpression = false;
      P.symbols = "";
      P.clearImageCacheAndExit = false;
      P.cacheGeneratedImages = false;
      P.generateOutput = true;
      P.singleThreaded = false;
      P.optimization = true;
      P.use64BitWorkingImage = false;
      P.rescale = false;
      P.rescaleLower = 0;
      P.rescaleUpper = 1;
      P.truncate = true;
      P.truncateLower = 0;
      P.truncateUpper = 1;
      P.createNewImage = true;
      P.showNewImage = true;
      P.newImageId = outId;
      P.newImageWidth = 0;
      P.newImageHeight = 0;
      P.newImageAlpha = false;
      P.newImageColorSpace = PixelMath.prototype.RGB;
      P.newImageSampleFormat = PixelMath.prototype.SameAsTarget;

      var anchorWin = requireWin( gId );
      if ( !P.executeOn( anchorWin.mainView ) )
         throw new Error( "PixelMath execution failed." );

      pumpEvents();
      var outWin = ImageWindow.windowById( outId );
      if ( outWin == null || outWin.isNull )
         outWin = ImageWindow.activeWindow;

      if ( outWin == null || outWin.isNull )
         throw new Error( "PixelMath output image not found: " + outId );

      if ( copyAstrometricMetadata( anchorWin, outWin ) )
         log( "Astrometry copied to " + outWin.mainView.id + " from " + anchorWin.mainView.id );
      else
         log( "Warning: Could not copy astrometry (source has no solution or PI build does not support copyAstrometricSolution)." );

}
   else
   {
      if ( dlg.mode === "RGB" )
      {
         log( "Combining RGB using ChannelCombination" );
         log( "R = " + rId );
         log( "G = " + gId );
         log( "B = " + bId );
      }
      else
      {
         var palette = dlg.palette_Combo.itemText( dlg.palette_Combo.currentItem );

         if ( palette === "HSO" )
         {
            rId = "Ha" + suffix;
            gId = "Sii" + suffix;
            bId = "Oiii" + suffix;

            log( "Combining HSO using ChannelCombination" );
            log( "R = " + rId + " (Ha)" );
            log( "G = " + gId + " (Sii)" );
            log( "B = " + bId + " (Oiii)" );
         }
         else if ( palette === "HOO" )
         {
            rId = "Ha" + suffix;
            gId = "Oiii" + suffix;
            bId = "Oiii" + suffix;

            log( "Combining HOO using ChannelCombination" );
            log( "R = " + rId + " (Ha)" );
            log( "G = " + gId + " (Oiii)" );
            log( "B = " + bId + " (Oiii)" );
         }
         else
         {
            rId = "Sii" + suffix;
            gId = "Ha" + suffix;
            bId = "Oiii" + suffix;

            log( "Combining SHO using ChannelCombination" );
            log( "R = " + rId + " (Sii)" );
            log( "G = " + gId + " (Ha)" );
            log( "B = " + bId + " (Oiii)" );
         }
      }

      requireWin( rId );
      requireWin( gId );
      requireWin( bId );

      log( "Creating combined image: " + outId );

      var combinedView = combineToRGB( rId, gId, bId, outId );

      var outWin = ImageWindow.windowById( outId );
      if ( outWin && !outWin.isNull )
      {
         outWin.show();
         ImageWindow.activeWindow = outWin;
         outWin.bringToFront();
         pumpEvents();
      }
   }

   var outWin2 = ImageWindow.windowById( outId );
   if ( outWin2 && !outWin2.isNull )
   {
      outWin2.show();
      ImageWindow.activeWindow = outWin2;
      outWin2.bringToFront();
      pumpEvents();
   }

   log( "Combination complete: " + outId );

	tick( "Combination" );
   beginStep( 6, "Color Correction" );

   var finalId = ( dlg.out_Edit.text || "" ).trim();
   var combinedWin = ImageWindow.windowById( finalId );
   if ( combinedWin == null || combinedWin.isNull )
      throw new Error( "Combined image not found for SPCC: " + finalId );

   var combinedView = combinedWin.mainView;
   var spcc = new SpectrophotometricColorCalibration;

   spcc.catalogId = "GaiaDR3SP";
   spcc.autoLimitMagnitude = true;
   spcc.targetSourceCount = 8000;
   spcc.saturationThreshold = 0.75;
   spcc.saturationRelative = true;
   spcc.neutralizeBackground = true;
   spcc.backgroundLow = -2.80;
   spcc.backgroundHigh = 2.00;

   spcc.deviceQECurve = "402,0.7219,404,0.7367,406,0.75,408,0.7618,410,0.7751,412,0.787,414,0.7944,416,0.8018,418,0.8112,420,0.8214,422,0.8343,424,0.8462,426,0.8536,428,0.8595,430,0.8639,432,0.8713,434,0.8757,436,0.8802,438,0.8861,440,0.8905,442,0.895,444,0.8994,446,0.9038,448,0.9068,450,0.9112,452,0.9142,454,0.9172,456,0.9168,458,0.9151,460,0.9134,462,0.9117,464,0.91,466,0.9083,468,0.9066,470,0.9049,472,0.9032,474,0.9015,476,0.8997,478,0.898,480,0.8963,482,0.8946,484,0.8929,486,0.8912,488,0.8876,490,0.8846,492,0.8877,494,0.8904,496,0.893,498,0.8964,500,0.8964,502,0.895,504,0.8945,506,0.8922,508,0.8899,510,0.8876,512,0.8853,514,0.883,516,0.8807,518,0.8784,520,0.8761,522,0.8743,524,0.8728,526,0.8698,528,0.8669,530,0.8624,532,0.858,534,0.855,536,0.8506,538,0.8476,540,0.8432,542,0.8402,544,0.8358,546,0.8328,548,0.8284,550,0.8254,552,0.821,554,0.8166,556,0.8136,558,0.8092,560,0.8062,562,0.8023,564,0.7983,566,0.7944,568,0.7899,570,0.787,572,0.7825,574,0.7781,576,0.7751,578,0.7707,580,0.7663,582,0.7618,584,0.7559,586,0.75,588,0.7441,590,0.7396,592,0.7337,594,0.7278,596,0.7219,598,0.716,600,0.7101,602,0.7056,604,0.6997,606,0.695,608,0.6905,610,0.6852,612,0.6808,614,0.6763,616,0.6719,618,0.6675,620,0.663,622,0.6583,624,0.6553,626,0.6509,628,0.6464,630,0.642,632,0.6376,634,0.6317,636,0.6272,638,0.6213,640,0.6154,642,0.6109,644,0.6036,646,0.5962,648,0.5902,650,0.5843,652,0.5799,654,0.574,656,0.5695,658,0.5636,660,0.5592,662,0.5545,664,0.5504,666,0.5462,668,0.542,670,0.5378,672,0.5328,674,0.5286,676,0.5244,678,0.5203,680,0.5163,682,0.5133,684,0.5089,686,0.5044,688,0.4985,690,0.4926,692,0.4867,694,0.4793,696,0.4719,698,0.4645,700,0.4586,702,0.4541,704,0.4497,706,0.4453,708,0.4408,710,0.4364,712,0.432,714,0.4275,716,0.4216,718,0.4186,720,0.4142,722,0.4127,724,0.4103,726,0.4078,728,0.4053,730,0.4024,732,0.3979,734,0.3935,736,0.3891,738,0.3831,740,0.3802,742,0.3772,744,0.3743,746,0.3713,748,0.3669,750,0.3624,752,0.3595,754,0.3559,756,0.3526,758,0.3494,760,0.3462,762,0.3429,764,0.3397,766,0.3364,768,0.3332,770,0.33,772,0.3267,774,0.3235,776,0.3203,778,0.317,780,0.3138,782,0.3106,784,0.3073,786,0.3041,788,0.3009,790,0.2976,792,0.2937,794,0.2905,796,0.2873,798,0.284,800,0.2808,802,0.2776,804,0.2743,806,0.2731,808,0.2703,810,0.2674,812,0.2646,814,0.2618,816,0.2589,818,0.2561,820,0.2533,822,0.2504,824,0.2476,826,0.2456,828,0.2439,830,0.2433,832,0.2427,834,0.2421,836,0.2416,838,0.2411,840,0.2382,842,0.2322,844,0.2278,846,0.2219,848,0.2175,850,0.2114,852,0.2069,854,0.2023,856,0.1978,858,0.1932,860,0.1918,862,0.1911,864,0.1904,866,0.1897,868,0.189,870,0.1883,872,0.1879,874,0.1834,876,0.179,878,0.1731,880,0.1672,882,0.1612,884,0.1568,886,0.1524,888,0.1479,890,0.1464,892,0.1464,894,0.1464,896,0.1464,898,0.1481,900,0.1494,902,0.1494,904,0.1494,906,0.1464,908,0.1435,910,0.1391,912,0.1346,914,0.1302,916,0.1257,918,0.1228,920,0.1183,922,0.1139,924,0.1109,926,0.1093,928,0.1085,930,0.108,932,0.108,934,0.108,936,0.108,938,0.108,940,0.1058,942,0.1039,944,0.1021,946,0.0998,948,0.0958,950,0.0918,952,0.0888,954,0.0828,956,0.0769,958,0.074,960,0.0714,962,0.0695,964,0.0677,966,0.0658,968,0.0651,970,0.0636,972,0.0626,974,0.0616,976,0.0606,978,0.0596,980,0.0586,982,0.0576,984,0.0567,986,0.0557,988,0.0547,990,0.0537,992,0.0527,994,0.0517,996,0.0507";

   if ( dlg.mode_Combo.currentItem == 0 )
   {
      log( "Mode: SHO (Narrowband Settings)" );
      spcc.narrowbandMode = true;
      spcc.narrowbandOptimizeStars = true;
      spcc.generateGraphs = false;

      spcc.whiteReferenceSpectrum = "1,1.0,500,1.0,1000,1.0,1500,1.0,2000,1.0,2500,1.0";
      spcc.whiteReferenceName = "Photon Flux";

      spcc.redFilterWavelength = 673.1;
      spcc.redFilterBandwidth = 3.0;
      spcc.greenFilterWavelength = 656.3;
      spcc.greenFilterBandwidth = 3.0;
      spcc.blueFilterWavelength = 500.7;
      spcc.blueFilterBandwidth = 3.0;
   }
   else
   {
      log( "Mode: RGB (Broadband Settings)" );
      spcc.narrowbandMode = false;
      spcc.narrowbandOptimizeStars = false;
      spcc.generateGraphs = false;

      spcc.whiteReferenceSpectrum = "200.5,0.0715066,201.5,0.0689827,202.5,0.0720216,203.5,0.0685511,204.5,0.0712370,205.5,0.0680646,206.5,0.0683024,207.4,0.0729174,207.8,0.0702124,208.5,0.0727025,209.5,0.0688880,210.5,0.0690528,211.5,0.0697566,212.5,0.0705508,213.5,0.0654581,214.5,0.0676317,215.5,0.0699038,216.5,0.0674922,217.5,0.0668344,218.5,0.0661763,219.5,0.0690803,220.5,0.0670864,221.5,0.0635644,222.5,0.0619833,223.5,0.0668687,224.5,0.0640725,225.5,0.0614358,226.5,0.0628698,227.5,0.0649014,228.5,0.0673391,229.5,0.0638038,230.5,0.0643234,231.5,0.0614849,232.5,0.0493110,233.5,0.0574873,234.5,0.0555616,235.5,0.0609369,236.5,0.0557384,237.5,0.0578991,238.5,0.0536321,239.5,0.0575370,240.5,0.0555389,241.5,0.0571506,242.5,0.0615309,243.5,0.0595363,244.5,0.0634798,245.5,0.0628886,246.5,0.0622975,247.5,0.0600475,248.5,0.0608933,249.5,0.0580972,250.5,0.0653082,251.3,0.0576207,251.8,0.0588533,252.5,0.0566401,253.5,0.0582714,254.5,0.0575809,255.5,0.0633762,256.5,0.0610093,257.5,0.0652874,258.5,0.0642648,259.5,0.0632596,260.5,0.0609384,261.5,0.0600490,262.5,0.0636409,263.5,0.0682040,264.5,0.0754600,265.5,0.0806341,266.5,0.0699754,267.5,0.0739405,268.5,0.0755243,269.5,0.0697483,270.5,0.0736132,271.5,0.0678854,272.5,0.0663086,273.5,0.0709825,274.5,0.0602999,275.5,0.0630128,276.5,0.0669431,277.5,0.0701399,278.5,0.0641577,279.5,0.0511231,280.5,0.0550197,281.5,0.0692974,282.5,0.0753517,283.5,0.0723537,284.5,0.0679725,285.5,0.0634174,286.5,0.0742486,287.5,0.0783316,288.5,0.0771108,289.5,0.0801337,291,0.0914252,293,0.0862422,295,0.0838485,297,0.0858467,299,0.0865643,301,0.0875161,303,0.0893837,305,0.0905257,307,0.0935800,309,0.0934870,311,0.0982195,313,0.0953176,315,0.0961554,317,0.0995933,319,0.0924967,321,0.0978345,323,0.0907337,325,0.1054383,327,0.1143168,329,0.1135342,331,0.1106139,333,0.1119505,335,0.1099062,337,0.0967928,339,0.1022504,341,0.1039447,343,0.1063681,345,0.1091599,347,0.1109753,349,0.1181664,351,0.1232860,353,0.1163073,355,0.1267769,357,0.1035215,359,0.1042786,361,0.1176823,363,0.1219479,364,0.1250342,365,0.1363934,367,0.1407033,369,0.1288466,371,0.1379791,373,0.1127623,375,0.1318217,377,0.1528880,379,0.1670432,381,0.1727864,383,0.1243124,385,0.1639393,387,0.1724457,389,0.1520460,391,0.2043430,393,0.1427526,395,0.1870668,397,0.1244026,399,0.2329267,401,0.2556144,403,0.2542109,405,0.2491356,407,0.2379803,409,0.2541684,411,0.2279309,413,0.2533629,415,0.2557223,417,0.2584198,419,0.2560216,421,0.2587210,423,0.2498130,425,0.2609755,427,0.2495886,429,0.2412927,431,0.2182856,433,0.2579985,435,0.2483036,437,0.2928112,439,0.2713431,441,0.2828921,443,0.2975108,445,0.3012513,447,0.3161393,449,0.3221464,451,0.3585586,453,0.3219299,455,0.3334392,457,0.3568741,459,0.3412296,461,0.3498501,463,0.3424920,465,0.3478877,467,0.3611478,469,0.3560448,471,0.3456585,473,0.3587672,475,0.3690553,477,0.3657369,479,0.3671625,481,0.3666357,483,0.3761265,485,0.3466382,487,0.3121751,489,0.3651561,491,0.3688824,493,0.3627420,495,0.3786295,497,0.3733906,499,0.3510300,501,0.3338136,503,0.3540298,505,0.3527861,507,0.3680833,509,0.3507047,511,0.3597249,513,0.3486136,515,0.3372089,517,0.3152444,519,0.3257755,521,0.3499922,523,0.3744245,525,0.3907778,527,0.3490228,529,0.3972061,531,0.4203442,533,0.3740999,535,0.4084084,537,0.4070036,539,0.3993480,541,0.3942389,543,0.4010466,545,0.4128880,547,0.4055525,549,0.4094232,551,0.4053814,553,0.4201633,555,0.4269231,557,0.4193749,559,0.4105311,561,0.4257824,563,0.4239540,565,0.4310873,567,0.4218358,569,0.4360353,571,0.4229342,573,0.4583894,575,0.4425389,577,0.4481210,579,0.4320856,581,0.4507180,583,0.4645862,585,0.4513373,587,0.4516404,589,0.4033701,591,0.4466167,593,0.4513267,595,0.4524209,597,0.4613319,599,0.4546841,601,0.4499895,603,0.4631190,605,0.4724762,607,0.4724962,609,0.4569794,611,0.4599737,613,0.4363290,615,0.4488329,617,0.4267759,619,0.4545143,621,0.4514890,623,0.4384229,625,0.4256613,627,0.4470943,629,0.4565981,631,0.4458333,633,0.4533333,635,0.4546457,637,0.4535446,639,0.4638791,641,0.4561002,643,0.4617287,645,0.4594083,647,0.4597119,649,0.4517238,651,0.4686735,653,0.4686423,655,0.4544898,657,0.4255737,659,0.4640177,661,0.4711876,663,0.4679153,665,0.4689913,667,0.4592265,669,0.4668144,671,0.4498947,673,0.4629239,675,0.4559567,677,0.4596584,679,0.4549789,681,0.4586439,683,0.4653622,685,0.4543475,687,0.4632128,689,0.4711164,691,0.4709973,693,0.4685415,695,0.4696455,697,0.4769241,699,0.4760169,701,0.4701294,703,0.4815669,705,0.4850302,707,0.4707895,709,0.4570604,711,0.4465777,713,0.4382957,715,0.4379654,717,0.4446168,719,0.4350767,721,0.4466714,723,0.4579113,725,0.4625222,727,0.4669903,729,0.4615551,731,0.4763299,733,0.4793147,735,0.4857778,737,0.4997366,739,0.4915129,741,0.4926212,743,0.5062475,745,0.5072637,747,0.5170334,749,0.5173594,751,0.5244106,753,0.5344788,755,0.5397524,757,0.5387203,759,0.5280215,761,0.5191969,763,0.5085395,765,0.4984095,767,0.4749347,769,0.4878839,771,0.4798119,773,0.4821991,775,0.4799906,777,0.4870453,779,0.4928744,781,0.4934236,783,0.4904677,785,0.4849491,787,0.4947343,789,0.4890020,791,0.4789132,793,0.4822390,795,0.4795733,797,0.4973323,799,0.4988779,801,0.5054210,803,0.5087054,805,0.5103235,807,0.5187602,809,0.5151330,811,0.5223530,813,0.5396030,815,0.5475528,817,0.5543915,819,0.5380259,821,0.5321401,823,0.5366753,825,0.5372011,827,0.5440262,829,0.5390591,831,0.5212784,833,0.5187033,835,0.5197124,837,0.5241092,839,0.5070799,841,0.5253056,843,0.5003658,845,0.4896143,847,0.4910508,849,0.4964088,851,0.4753377,853,0.4986498,855,0.4604553,857,0.5174022,859,0.5105171,861,0.5175606,863,0.5322153,865,0.5335880,867,0.4811849,869,0.5241390,871,0.5458069,873,0.5508025,875,0.5423946,877,0.5580108,879,0.5677047,881,0.5580099,883,0.5649928,885,0.5629494,887,0.5384574,889,0.5523318,891,0.5614248,893,0.5521309,895,0.5550786,897,0.5583751,899,0.5597844,901,0.5394855,903,0.5638478,905,0.5862635,907,0.5877920,909,0.5774965,911,0.5866240,913,0.5989106,915,0.5958623,917,0.5964975,919,0.6041389,921,0.5797449,923,0.5607401,925,0.5640816,927,0.5704267,929,0.5642119,931,0.5694372,933,0.5716141,935,0.5705180,937,0.5618458,939,0.5736730,941,0.5630236,943,0.5796418,945,0.5720721,947,0.5873186,949,0.5896322,951,0.5794164,953,0.5828271,955,0.5692468,957,0.5808756,959,0.5949017,961,0.5875516,963,0.5923656,965,0.5824188,967,0.5838008,969,0.5948942,971,0.5865689,973,0.5818128,975,0.5807992,977,0.5851036,979,0.5775164,981,0.5938626,983,0.5885816,985,0.5943664,987,0.5911885,989,0.5916490,991,0.5868101,993,0.5919505,995,0.5945270,997,0.5960248,999,0.5950870,1003,0.5948938,1007,0.5888742,1013,0.6006343,1017,0.5958836,1022,0.6004154,1028,0.6050616,1032,0.5995678,1038,0.5984462,1043,0.6035475,1048,0.5973678,1052,0.5940806,1058,0.5854267,1063,0.5827191,1068,0.5788137,1072,0.5843356,1078,0.5830553,1082,0.5762549,1087,0.5766769,1092,0.5759526,1098,0.5726978,1102,0.5718654,1108,0.5658845,1113,0.5661672,1117,0.5637793,1122,0.5660178,1128,0.5608876,1133,0.5622964,1138,0.5603359,1143,0.5563605,1147,0.5652205,1153,0.5656560,1157,0.5607483,1162,0.5540304,1167,0.5556068,1173,0.5604768,1177,0.5492890,1183,0.5464411,1187,0.5385652,1192,0.5489344,1198,0.5331419,1203,0.5451093,1207,0.5419047,1212,0.5443417,1218,0.5477119,1223,0.5460783,1227,0.5435469,1232,0.5413216,1237,0.5419156,1243,0.5360791,1248,0.5363784,1253,0.5330056,1258,0.5330475,1262,0.5312735,1267,0.5282075,1272,0.5301258,1278,0.5318302,1283,0.5143390,1288,0.5259125,1292,0.5214670,1298,0.5287547,1302,0.5231621,1308,0.5267800,1313,0.5167545,1318,0.5170787,1323,0.5186867,1328,0.5111090,1332,0.5122823,1338,0.5085013,1343,0.5118057,1347,0.5086671,1352,0.5063367,1357,0.5007655,1363,0.5001648,1367,0.5036531,1373,0.5066053,1377,0.5064235,1382,0.5083958,1388,0.5053201,1393,0.4855558,1397,0.4835752,1402,0.4799809,1408,0.4854351,1412,0.4802711,1418,0.4867642,1423,0.4831264,1428,0.4768633,1433,0.4864127,1438,0.4916220,1442,0.4807589,1448,0.4908799,1452,0.4878666,1457,0.4919060,1462,0.4832121,1467,0.4817380,1472,0.4788120,1477,0.4832511,1483,0.4873623,1488,0.4833546,1492,0.4970729,1498,0.4941945,1503,0.4882672,1507,0.4906435,1512,0.5011545,1517,0.5042579,1522,0.5053326,1528,0.5103188,1533,0.5104235,1537,0.5109443,1543,0.5088747,1548,0.5114602,1552,0.5078479,1557,0.4955375,1562,0.5020681,1567,0.5009384,1572,0.5130484,1578,0.4843262,1583,0.4878957,1587,0.4869790,1593,0.5039261,1598,0.4961504,1605,0.5016433,1615,0.5109383,1625,0.5010374,1635,0.5166810,1645,0.4997573,1655,0.5132085,1665,0.5045445,1675,0.5038381,1685,0.4979366,1695,0.5024966,1705,0.4946397,1715,0.4900714,1725,0.4820987,1735,0.4704836,1745,0.4675962,1755,0.4610580,1765,0.4542064,1775,0.4442880,1785,0.4394009,1795,0.4305704,1805,0.4214249,1815,0.4154385,1825,0.4121445,1835,0.4087068,1845,0.4004347,1855,0.3981439,1865,0.3898276,1875,0.3819086,1885,0.3837946,1895,0.3719080,1905,0.3783857,1915,0.3734775,1925,0.3706359,1935,0.3625896,1945,0.3552610,1955,0.3559292,1965,0.3516581,1975,0.3442642,1985,0.3424439,1995,0.3401458,2005,0.3400624,2015,0.3370426,2025,0.3310865,2035,0.3294150,2045,0.3300824,2055,0.3263510,2065,0.3238343,2075,0.3226433,2085,0.3196882,2095,0.3156795,2105,0.3170735,2115,0.3129192,2125,0.3107151,2135,0.3111934,2145,0.3083829,2155,0.3053164,2165,0.3011248,2175,0.2987932,2185,0.2973707,2195,0.2953015,2205,0.2894185,2215,0.2910636,2225,0.2855524,2235,0.2835412,2245,0.2813240,2255,0.2794243,2265,0.2746838,2275,0.2752567,2285,0.2700351,2295,0.2315953,2305,0.2464873,2315,0.2460988,2325,0.2138361,2335,0.2290047,2345,0.2216595,2355,0.1997312,2365,0.2151513,2375,0.2079374,2385,0.1903472,2395,0.2020694,2405,0.1988067,2415,0.1834113,2425,0.1912983,2435,0.1873909,2445,0.1783537,2455,0.1759682,2465,0.1784857,2475,0.1715942,2485,0.1573562,2495,0.1568707,2505,0.1598265";
      spcc.whiteReferenceName = "Average Spiral Galaxy";

      spcc.redFilterWavelength = 656.3;
      spcc.redFilterBandwidth = 3.0;
      spcc.greenFilterWavelength = 500.7;
      spcc.greenFilterBandwidth = 3.0;
      spcc.blueFilterWavelength = 500.7;
      spcc.blueFilterBandwidth = 3.0;

      spcc.broadbandIntegrationStepSize = 0.50;
   }

   spcc.redFilterTrCurve = "400,0.088,402,0.084,404,0.080,406,0.076,408,0.072,410,0.068,412,0.065,414,0.061,416,0.058,418,0.055,420,0.052,422,0.049,424,0.046,426,0.044,428,0.041,430,0.039,432,0.037,434,0.035,436,0.033,438,0.031,440,0.030,442,0.028,444,0.027,446,0.026,448,0.025,450,0.024,452,0.023,454,0.022,456,0.021,458,0.021,460,0.021,462,0.020,464,0.020,466,0.020,468,0.020,470,0.020,472,0.021,474,0.021,476,0.022,478,0.022,480,0.023,482,0.024,484,0.025,486,0.026,488,0.027,490,0.028,492,0.029,494,0.031,496,0.032,498,0.034,500,0.036,502,0.037,504,0.039,506,0.041,508,0.043,510,0.045,512,0.048,514,0.050,516,0.052,518,0.055,520,0.057,522,0.060,524,0.063,526,0.071,528,0.072,530,0.070,532,0.067,534,0.064,536,0.059,538,0.054,540,0.050,542,0.045,544,0.041,546,0.037,548,0.034,550,0.032,552,0.031,554,0.031,556,0.032,558,0.035,560,0.038,562,0.043,564,0.048,566,0.055,568,0.062,570,0.070,572,0.122,574,0.187,576,0.262,578,0.346,580,0.433,582,0.521,584,0.606,586,0.686,588,0.755,590,0.812,592,0.851,594,0.871,596,0.876,598,0.885,600,0.892,602,0.896,604,0.897,606,0.897,608,0.895,610,0.891,612,0.887,614,0.882,616,0.878,618,0.873,620,0.870,622,0.867,624,0.863,626,0.860,628,0.858,630,0.856,632,0.854,634,0.852,636,0.850,638,0.848,640,0.846,642,0.844,644,0.841,646,0.837,648,0.834,650,0.829,652,0.824,654,0.819,656,0.813,658,0.806,660,0.799,662,0.791,664,0.783,666,0.774,668,0.765,670,0.755,672,0.745,674,0.735,676,0.725,678,0.715,680,0.704,682,0.695,684,0.685,686,0.676,688,0.668,690,0.660,692,0.654,694,0.649,696,0.648,698,0.649,700,0.649";
   spcc.greenFilterTrCurve = "400,0.089,402,0.086,404,0.082,406,0.079,408,0.075,410,0.071,412,0.066,414,0.062,416,0.058,418,0.053,420,0.049,422,0.045,424,0.042,426,0.041,428,0.042,430,0.043,432,0.044,434,0.046,436,0.047,438,0.049,440,0.051,442,0.053,444,0.055,446,0.057,448,0.059,450,0.061,452,0.064,454,0.067,456,0.069,458,0.072,460,0.075,462,0.098,464,0.130,466,0.169,468,0.215,470,0.267,472,0.323,474,0.382,476,0.443,478,0.505,480,0.566,482,0.627,484,0.684,486,0.739,488,0.788,490,0.832,492,0.868,494,0.896,496,0.915,498,0.924,500,0.921,502,0.939,504,0.947,506,0.954,508,0.961,510,0.967,512,0.973,514,0.978,516,0.982,518,0.986,520,0.989,522,0.992,524,0.994,526,0.996,528,0.997,530,0.997,532,0.995,534,0.990,536,0.986,538,0.981,540,0.977,542,0.973,544,0.969,546,0.965,548,0.960,550,0.955,552,0.949,554,0.943,556,0.936,558,0.928,560,0.919,562,0.909,564,0.898,566,0.887,568,0.874,570,0.860,572,0.845,574,0.829,576,0.812,578,0.794,580,0.775,582,0.754,584,0.733,586,0.711,588,0.688,590,0.665,592,0.640,594,0.615,596,0.589,598,0.563,600,0.537,602,0.510,604,0.483,606,0.456,608,0.430,610,0.403,612,0.377,614,0.352,616,0.328,618,0.304,620,0.282,622,0.261,624,0.242,626,0.224,628,0.225,630,0.216,632,0.207,634,0.199,636,0.192,638,0.185,640,0.179,642,0.174,644,0.169,646,0.165,648,0.161,650,0.158,652,0.156,654,0.155,656,0.154,658,0.154,660,0.155,662,0.156,664,0.158,666,0.162,668,0.165,670,0.170,672,0.176,674,0.182,676,0.189,678,0.198,680,0.207,682,0.217,684,0.228,686,0.240,688,0.240,690,0.248,692,0.257,694,0.265,696,0.274,698,0.282,700,0.289";
   spcc.blueFilterTrCurve = "400,0.438,402,0.469,404,0.496,406,0.519,408,0.539,410,0.557,412,0.572,414,0.586,416,0.599,418,0.614,420,0.631,422,0.637,424,0.647,426,0.658,428,0.670,430,0.682,432,0.695,434,0.708,436,0.720,438,0.732,440,0.743,442,0.753,444,0.762,446,0.770,448,0.777,450,0.783,452,0.788,454,0.791,456,0.794,458,0.796,460,0.797,462,0.798,464,0.798,466,0.799,468,0.800,470,0.801,472,0.800,474,0.798,476,0.793,478,0.785,480,0.774,482,0.760,484,0.742,486,0.707,488,0.669,490,0.633,492,0.598,494,0.565,496,0.533,498,0.502,500,0.473,502,0.446,504,0.419,506,0.394,508,0.370,510,0.348,512,0.326,514,0.306,516,0.287,518,0.268,520,0.251,522,0.235,524,0.220,526,0.205,528,0.192,530,0.179,532,0.167,534,0.156,536,0.145,538,0.136,540,0.126,542,0.118,544,0.110,546,0.102,548,0.095,550,0.089,552,0.083,554,0.077,556,0.071,558,0.066,560,0.061,562,0.057,564,0.052,566,0.048,568,0.044,570,0.039,572,0.041,574,0.039,576,0.037,578,0.035,580,0.033,582,0.032,584,0.030,586,0.029,588,0.027,590,0.026,592,0.025,594,0.024,596,0.023,598,0.022,600,0.022,602,0.021,604,0.021,606,0.020,608,0.020,610,0.020,612,0.020,614,0.020,616,0.020,618,0.021,620,0.021,622,0.022,624,0.022,626,0.023,628,0.024,630,0.025,632,0.026,634,0.027,636,0.028,638,0.030,640,0.031,642,0.033,644,0.035,646,0.036,648,0.038,650,0.040,652,0.042,654,0.045,656,0.048,658,0.051,660,0.054,662,0.057,664,0.059,666,0.061,668,0.063,670,0.065,672,0.066,674,0.068,676,0.069,678,0.070,680,0.071,682,0.072,684,0.072,686,0.073,688,0.073,690,0.073,692,0.073,694,0.073,696,0.073,698,0.073,700,0.073";

   log( "Executing SPCC on " + combinedView.fullId );
   if ( !spcc.executeOn( combinedView ) )
      throw new Error( "SPCC failed." );

   pumpEvents();
   pauseMs( 500 );

   log( "Applying Visual STF" );
   applyVisualSTF( combinedView, DEFAULT_AUTOSTRETCH_SCLIP, DEFAULT_AUTOSTRETCH_TBGND, true );

		tick( "SPCC" );
   beginStep( 7, "Noise Reduction (Linear)" );

   var rgbId = dlg.out_Edit.text;
   if ( !rgbId || !rgbId.trim().length ) rgbId = "RGB";

   var rgbWin = ImageWindow.windowById( rgbId );

   if ( rgbWin == null || rgbWin.isNull )
   {
      log( "NXT Error: Could not find the merged image: " + rgbId );
   }
   else
   {
      var nxt = new NoiseXTerminator;
      nxt.ai_file = "NoiseXTerminator.3.pb";
      nxt.enable_color_separation = false;
      nxt.enable_frequency_separation = false;

      nxt.denoise = Math.range( Number( dlg.nxtDenoise_Edit.text ), 0.0, 1.0 );
      if ( isNaN( nxt.denoise ) ) nxt.denoise = 0.50;

      nxt.iterations = Math.round( Number( dlg.nxtIterations_Edit.text ) );
      if ( isNaN( nxt.iterations ) || (nxt.iterations !== 1 && nxt.iterations !== 2) )
         nxt.iterations = 1;

log( "Applying NXT to merged image: " + rgbId );
      nxt.executeOn( rgbWin.mainView );

      var nxtId = rgbId + "_NXT";
      renameMainViewTo( rgbWin.mainView, nxtId );

      applyVisualSTF( rgbWin.mainView );
      log( "NXT Completed. Current view: " + nxtId );
		tick( "NXT" );
   }

   beginStep( 8, "Sharpening (Linear)" );

   var inId = (dlg.out_Edit && dlg.out_Edit.text) ? dlg.out_Edit.text + "_NXT" : "RGB_NXT";
   var win = ImageWindow.windowById( inId );

   if ( win == null || win.isNull )
   {
      log( "BXT Error: Could not find image window: " + inId );
   }
   else
   {
      var bxt2 = new BlurXTerminator;
      bxt2.ai_file = "BlurXTerminator.4.pb";
      bxt2.correct_only = false;
      bxt2.correct_first = false;
      bxt2.nonstellar_then_stellar = false;
      bxt2.lum_only = false;
      bxt2.sharpen_stars = Math.range( Number( dlg.bxtSharpenStars_Edit.text ), 0.0, 0.7 );
      if ( isNaN( bxt2.sharpen_stars ) ) bxt2.sharpen_stars = 0.50;
      bxt2.adjust_halos = Math.range( Number( dlg.bxtAdjustHalos_Edit.text ), -0.5, 0.5 );
      if ( isNaN( bxt2.adjust_halos ) ) bxt2.adjust_halos = -0.10;
      bxt2.nonstellar_psf_diameter = 0.00;
      bxt2.auto_nonstellar_psf = true;
      bxt2.sharpen_nonstellar = Math.range( Number( dlg.bxtSharpenNonstellar_Edit.text ), 0.0, 1.0 );
      if ( isNaN( bxt2.sharpen_nonstellar ) ) bxt2.sharpen_nonstellar = 0.50;

      log( "Sharpening linear image: " + inId );
      bxt2.executeOn( win.mainView );

      var bxtId = inId + "_BXT";
      renameMainViewTo( win.mainView, bxtId );

      applyVisualSTF( win.mainView );
      log( "BXT Completed. Current view: " + bxtId );
		tick( "BXT sharpen" );
   }

   beginStep( 9, "Star Extraction" );

   var inId2 = (dlg.out_Edit && dlg.out_Edit.text) ? dlg.out_Edit.text + "_NXT_BXT" : "RGB_NXT_BXT";
   var win2 = ImageWindow.windowById( inId2 );

   if ( win2 == null || win2.isNull )
   {
      log( "SXT Error: Could not find image window: " + inId2 );
   }
   else
   {
      var sxt = new StarXTerminator;
      sxt.ai_file = "StarXTerminator.lite.nonoise.11.pb";
      sxt.stars = dlg.sxtGenerateStars_Check.checked;
      sxt.unscreen = dlg.sxtUnscreen_Check.checked;
      sxt.overlap = dlg.sxtLargeOverlap_Check.checked ? 0.50 : 0.20;

      log( "Separating stars from: " + inId2 );
      sxt.executeOn( win2.mainView );

      var starlessId = "starless_linear";
      renameMainViewTo( win2.mainView, starlessId );

      log( "Starless image created: " + starlessId );

      var starsWin = ImageWindow.windowById( "Stars" );
      if ( starsWin == null || starsWin.isNull )
      {
         var allWins = ImageWindow.windows;
         for ( var i = 0; i < allWins.length; ++i )
         {
            var wid = allWins[i].mainView.id;
            var low = wid.toLowerCase();
            if ( low.indexOf( "stars" ) >= 0 && low.indexOf( "starless" ) < 0 )
            {
               starsWin = allWins[i];
               break;
            }
         }
      }

      if ( starsWin != null && !starsWin.isNull )
      {
         renameMainViewTo( starsWin.mainView, "stars_linear" );
         log( "Stars image renamed to: stars_linear" );
      }
      else
      {
         log( "Stars image created (could not auto rename, please rename manually to 'stars_linear')." );
      }

		tick( "SXT" );
   }

   var linId = "starless_linear";
   var linWin = ImageWindow.windowById( linId );

   if ( (dlg.stretch_Check && dlg.stretch_Check.checked) || (dlg.masApply_Check && dlg.masApply_Check.checked) )
   {
      if ( linWin == null || linWin.isNull )
      {
         log( "Stretch Error: Could not find starless image: " + linId );
      }
      else
      {
         beginStep( 10, "Stretching" );

         var __doHT = ( dlg.stretch_Check && dlg.stretch_Check.checked );
         var __doMAS = ( dlg.masApply_Check && dlg.masApply_Check.checked );

         if ( !__doHT && !__doMAS )
         {
            endStep( "Skipped (HT and MAS disabled)" );
         }
         else
         {
            if ( __doHT )
            {
               logSub( "HistogramTransformation stretch (STF to HT style)" );

            var htWin = new ImageWindow(
               linWin.mainView.image.width,
               linWin.mainView.image.height,
               linWin.mainView.image.numberOfChannels,
               linWin.mainView.window.bitsPerSample,
               linWin.mainView.window.isFloatSample,
               linWin.mainView.image.isColor,
               "HT_starless"
            );

            htWin.mainView.beginProcess();
            htWin.mainView.image.assign( linWin.mainView.image );
            htWin.mainView.endProcess();
            htWin.show();

            var htView = htWin.mainView;

            var median = htView.computeOrFetchProperty( "Median" );
            var mad = htView.computeOrFetchProperty( "MAD" );
            mad.mul( 1.4826 );

            var n = htView.image.isColor ? 3 : 1;
            var ht = new HistogramTransformation;

            var avgC0 = 0, avgM = 0;
            for ( var c = 0; c < n; ++c )
            {
               if ( 1 + mad.at( c ) != 1 )
                  avgC0 += median.at( c ) + DEFAULT_AUTOSTRETCH_SCLIP * mad.at( c );
               avgM += median.at( c );
            }

            avgC0 = Math.range( avgC0/n, 0.0, 1.0 );

            var htTbgnd = DEFAULT_AUTOSTRETCH_TBGND;
            try
            {
               if ( dlg && dlg.htTbg_Edit )
               {
                  htTbgnd = Number( dlg.htTbg_Edit.text );
                  if ( isNaN( htTbgnd ) ) htTbgnd = DEFAULT_AUTOSTRETCH_TBGND;
                  htTbgnd = Math.range( htTbgnd, 0.0, 1.0 );
               }
            }
            catch ( __e ) { htTbgnd = DEFAULT_AUTOSTRETCH_TBGND; }

            avgM  = Math.mtf( htTbgnd, avgM/n - avgC0 );

            var A = [
               [avgC0, avgM, 1.0, 0.0, 1.0],
               [avgC0, avgM, 1.0, 0.0, 1.0],
               [avgC0, avgM, 1.0, 0.0, 1.0],
               [0, 0.5, 1, 0, 1]
            ];

            ht.H = A;

            log( "Executing LINKED stretch on: " + htView.id );
            ht.executeOn( htView );

            htView.stf = [
               [0.5, 0, 1, 0, 1],
               [0.5, 0, 1, 0, 1],
               [0.5, 0, 1, 0, 1],
               [0.5, 0, 1, 0, 1]
            ];

            log( "Linked HT stretch complete: " + htView.id );
            tick( "HT Stretch" );
         }
         else
         {
            log( "HT stretch disabled (skipping HistogramTransformation stretch)." );
         }

         if ( dlg.masApply_Check && dlg.masApply_Check.checked )
         {
            logSub( "Multiscale Adaptive Stretch (MAS)" );

            var masWin = new ImageWindow(
               linWin.mainView.image.width,
               linWin.mainView.image.height,
               linWin.mainView.image.numberOfChannels,
               linWin.mainView.window.bitsPerSample,
               linWin.mainView.window.isFloatSample,
               linWin.mainView.image.isColor,
               "MAS_starless"
            );

            masWin.mainView.beginProcess();
            masWin.mainView.image.assign( linWin.mainView.image );
            masWin.mainView.endProcess();
            masWin.show();

            var masView = masWin.mainView;

            var P = new MultiscaleAdaptiveStretch;
// Locate background ROI for MAS (clean, flat, starless input assumed)
try
{
   sbppUiLog( dlg, "Locating background region (50x50)..." );
   var __bg = findBackground( masView.fullId, 50, 50 );
   sbppUiLog( dlg, format( "Background ROI located at Left=%d, Top=%d", __bg.left, __bg.top ) );

   P.backgroundROIEnabled = true;
   P.backgroundROIX0 = __bg.left;
   P.backgroundROIY0 = __bg.top;
   P.backgroundROIWidth = 50;
   P.backgroundROIHeight = 50;
}
catch ( __eBG )
{
   sbppUiLog( dlg, "Warning: Background region location failed. Proceeding without ROI. (" + __eBG + ")" );
   P.backgroundROIEnabled = false;
}



            P.aggressiveness = Number( dlg.masAgg_Edit.text );
            if ( isNaN( P.aggressiveness ) ) P.aggressiveness = 0.70;
            P.aggressiveness = Math.range( P.aggressiveness, 0.0, 1.0 );

            P.targetBackground = Number( dlg.masTbg_Edit.text );
            if ( isNaN( P.targetBackground ) ) P.targetBackground = 0.15;
            P.targetBackground = Math.range( P.targetBackground, 0.0, 1.0 );

            P.dynamicRangeCompression = Number( dlg.masDRC_Edit.text );
            if ( isNaN( P.dynamicRangeCompression ) ) P.dynamicRangeCompression = 0.40;
            P.dynamicRangeCompression = Math.range( P.dynamicRangeCompression, 0.0, 1.0 );

            P.contrastRecovery = !!dlg.masContrast_Check.checked;

            P.scaleSeparation = 1024;
try
{
   if ( dlg.masScale_Combo )
   {
      var __msText = String( dlg.masScale_Combo.itemText( dlg.masScale_Combo.currentItem ) );
      var __msVal = Number( __msText );
      if ( isFinite( __msVal ) ) P.scaleSeparation = __msVal;
   }
}
catch ( __eMS ) { P.scaleSeparation = 1024; }

P.contrastRecoveryIntensity = 1.0;
try
{
   var __ci = Number( dlg.masCRIntensity_Edit ? dlg.masCRIntensity_Edit.text : 1.0 );
   if ( !isFinite( __ci ) ) __ci = 1.0;
   P.contrastRecoveryIntensity = Math.range( __ci, 0.0, 1.0 );
}
catch ( __eCI ) { P.contrastRecoveryIntensity = 1.0; }




            P.previewLargeScale = !!dlg.masPreview_Check.checked;

            P.saturationEnabled = !!dlg.masSatEnabled_Check.checked;

            P.saturationAmount = Number( dlg.masSatAmt_Edit.text );
            if ( isNaN( P.saturationAmount ) ) P.saturationAmount = 0.75;
            P.saturationAmount = Math.range( P.saturationAmount, 0.0, 1.0 );

            P.saturationBoost = Number( dlg.masSatBoost_Edit.text );
            if ( isNaN( P.saturationBoost ) ) P.saturationBoost = 0.50;
            P.saturationBoost = Math.range( P.saturationBoost, 0.0, 1.0 );

            P.saturationLightnessMask = !!dlg.masSatLM_Check.checked;

            log( "Executing MAS on: " + masView.id );
            P.executeOn( masView );

            masView.stf = [
               [0.5, 0, 1, 0, 1],
               [0.5, 0, 1, 0, 1],
               [0.5, 0, 1, 0, 1],
               [0.5, 0, 1, 0, 1]
            ];

            log( "MAS stretch complete: " + masView.id );
            tick( "MAS Stretch" );
         }
         else
         {
            log( "MAS disabled (skipping MultiscaleAdaptiveStretch)." );
         }
      }
   }


   function applyNonlinearNXT( id )
   {
      var w = ImageWindow.windowById( id );
      if ( w == null || w.isNull )
      {
         log( "Nonlinear NXT: window not found: " + id );
         return;
      }

      var nxtnl = new NoiseXTerminator;
      nxtnl.ai_file = "NoiseXTerminator.3.pb";
      nxtnl.enable_color_separation = false;
      nxtnl.enable_frequency_separation = false;

      nxtnl.denoise = Math.range( Number( dlg.nlNxtDenoise_Edit.text ), 0.0, 1.0 );
      if ( isNaN( nxtnl.denoise ) ) nxtnl.denoise = 0.30;

      nxtnl.iterations = Math.round( Number( dlg.nlNxtIterations_Edit.text ) );
      if ( isNaN( nxtnl.iterations ) || (nxtnl.iterations !== 1 && nxtnl.iterations !== 2) )
         nxtnl.iterations = 1;

      log( "Applying Nonlinear NXT to: " + id + " (denoise=" + nxtnl.denoise.toFixed(2) + ", it=" + nxtnl.iterations + ")" );
      nxtnl.executeOn( w.mainView );

      applyVisualSTF( w.mainView );
      tick( "NL NXT " + id );
   }

   function applyNonlinearBXT( id )
   {
      var w = ImageWindow.windowById( id );
      if ( w == null || w.isNull )
      {
         log( "Nonlinear BXT: window not found: " + id );
         return;
      }

      var bxtnl = new BlurXTerminator;
      bxtnl.ai_file = "BlurXTerminator.4.pb";
      bxtnl.correct_only = false;
      bxtnl.correct_first = false;
      bxtnl.nonstellar_then_stellar = false;
      bxtnl.lum_only = false;

      bxtnl.sharpen_stars = Math.range( Number( dlg.nlBxtSharpenStars_Edit.text ), 0.0, 0.7 );
      if ( isNaN( bxtnl.sharpen_stars ) ) bxtnl.sharpen_stars = 0.0;

      bxtnl.adjust_halos = Math.range( Number( dlg.nlBxtAdjustHalos_Edit.text ), -0.5, 0.5 );
      if ( isNaN( bxtnl.adjust_halos ) ) bxtnl.adjust_halos = 0.0;

      bxtnl.nonstellar_psf_diameter = 0.00;
      bxtnl.auto_nonstellar_psf = true;

      bxtnl.sharpen_nonstellar = Math.range( Number( dlg.nlBxtSharpenNonstellar_Edit.text ), 0.0, 1.0 );
      if ( isNaN( bxtnl.sharpen_nonstellar ) ) bxtnl.sharpen_nonstellar = 0.25;

      log( "Applying Nonlinear BXT to: " + id +
           " (stars=" + bxtnl.sharpen_stars.toFixed(2) +
           ", halos=" + bxtnl.adjust_halos.toFixed(2) +
           ", nonstellar=" + bxtnl.sharpen_nonstellar.toFixed(2) + ")" );

      bxtnl.executeOn( w.mainView );

      applyVisualSTF( w.mainView );
      tick( "NL BXT " + id );
   }

   var __targets = [];
   if ( dlg.stretch_Check && dlg.stretch_Check.checked )
      __targets.push( "HT_starless" );
   if ( dlg.masApply_Check && dlg.masApply_Check.checked )
      __targets.push( "MAS_starless" );

   if ( __targets.length == 0 )
      log( "No stretched starless targets found (nonlinear steps will have nothing to do)." );

   if ( dlg.nlNxtApply_Check && dlg.nlNxtApply_Check.checked )
   {
      beginStep( 11, "Noise Reduction (Nonlinear)" );
      for ( var __t = 0; __t < __targets.length; ++__t )
         applyNonlinearNXT( __targets[__t] );
   }
   else
   {
      beginStep( 11, "Noise Reduction (Nonlinear)" );
      endStep( "Skipped (Nonlinear NXT disabled)" );
   }


   if ( dlg.nlBxtApply_Check && dlg.nlBxtApply_Check.checked )
   {
      beginStep( 12, "Sharpening (Nonlinear)" );
      for ( var __t2 = 0; __t2 < __targets.length; ++__t2 )
         applyNonlinearBXT( __targets[__t2] );
   }
   else
   {
      beginStep( 12, "Sharpening (Nonlinear)" );
      endStep( "Skipped (Nonlinear BXT disabled)" );
   }
   var __keep = {
      "stars_linear": true,
      "starless_linear": true,
      "HT_starless": true,
      "MAS_starless": true
   };

   var __wins = ImageWindow.windows;
   for ( var __i = 0; __i < __wins.length; ++__i )
   {
      var __w = __wins[__i];
      if ( __w == null )
         continue;
      var __id = __w.mainView.id;

      if ( __keep[__id] )
         continue;

      __w.forceClose();
   }


   if ( __progress ) __progress.done();

   var __elapsed = "";
   if ( __runStartMS > 0 )
      __elapsed = formatElapsedMMSS( (new Date).getTime() - __runStartMS );

   log( "-----------------------------" );
   log( "  R U N   C O M P L E T E D" );
   if ( __elapsed.length > 0 )
      log( "  Elapsed time: " + __elapsed );
   log( "-----------------------------" );


   sbppTrySaveCurrentConfiguration( dlg, log );


}
}

function main()
{
   try
   {
      (new WorkflowDialog).execute();
   }
   catch ( e )
   {
      try
      {
         var s = ( e && e.toString ) ? e.toString() : String( e );
         if ( s.indexOf( "__SBPP_PREREQ__" ) >= 0 )
            return;
      }
      catch ( __e2 ) {}

      throw e;
   }
}
main();
