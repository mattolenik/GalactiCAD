#ifndef _VORTEX_H
#define _VORTEX_H
// vortex.h

// Standard include files
//
//#include <sys/time.h>
//#include <sys/resource.h>
#include <varargs.h>
#include <iostream.h>
//#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <string.h>
#include <math.h>
#include <malloc.h>
#include <ctype.h>



// Constants

#ifndef NULL
#define NULL        0l
#endif

// Boolean Constants

#ifndef FALSE
#define FALSE        0
#define TRUE        (~FALSE)
#endif



// Typedef(s) & structs(s)
// Machine independent typedefs
// Change for each machine the software is ported to

typedef unsigned char   UNS8;
typedef unsigned short  UNS16;
typedef unsigned long   UNS32;
typedef signed   char   INT8;
typedef signed   short  INT16;
typedef signed   long   INT32;

typedef double aCoord;  // co ordinate value

typedef int aBoolean;

typedef UNS8 aByte;
typedef UNS32 aMemsize;


#define  UNAVAILABLE  0x00
#define  NEW          0x01
#define  POINTING     0x02
#define  AVAILABLE    0x04
#define  COMPRESSED   0x08
#define  BUNDLE       0x10

#define  FILEERROR    0x80

#define  ONEBYTE      1
#define  TWOBYTE      2

#define  ANUNS16      1
#define  AFLOAT       2
#define  FLOATLIMIT   0.000001

#define  COLORMAX   (255)
#define  MAXTEXT    128




// Structs(s)
// ----------------------


// Header section of the Image data file (The first 256 bytes)

typedef struct  {
        char   fileid[5];
       aByte   control_z;
       UNS16   version;
       UNS16   xres;
       UNS16   yres;
       UNS16   zres;
       UNS16   flags;
       UNS32   map_offset;
       UNS32   voxel_offset;
        UNS8   unused[104];
        char   text[MAXTEXT];
 } fileheader;


typedef struct 
{
              char   status;
              UNS16  flags;
              char   format;
              double xunit;
              double yunit;
              double zunit;
              int    nslices;
              int    nvolumes;
              int    xsize;
              int    ysize;
              int    datazres;
              UNS16  *data;
              float  *xyzmap;
              aCoord *xmap;
              aCoord *ymap;
              aCoord *zmap;
} volume;




struct plane {
       float r;
       float gamma;
       float alpha;
};

struct cube {

       float x[8];
       float y[8];
       float z[8];

       char edge[12][3];
       char edgevariable[12];

       short nextedge[12][6];

       short ncut;
       float xcut[16];
       float ycut[16];
       float zcut[16];
 
};

struct textureVolume {

       int    nx;
       int    ny;
       int    nslices;
       int    nvolumes;

       float  unitx;
       float  unity;
       float  unitz;
       float  scalefactor;

       unsigned char   *volumeData;

       float  w;
       float  h;
       float  d;
       float  xl;
       float  xr;
       float  yb;
       float  yt;
       float  zf;
       float  zb;

       float  ucxmin;
       float  ucxmax;
       float  ucymin;
       float  ucymax;
       float  uczmin;
       float  uczmax;
       float  uczmaxlimit;

       float  cubesize;
       float  tunitx;
       float  tunity;
       float  tunitz;

       short  textureNz;
       short  ntextures;

       short  quality;
       float  slicepitch[2];

       float  pdcut;
       cube   uc;

       short  chopped;
       plane  cp;

};



#define ARRAYMAX   256
#define YRANGE     255

#define TEXTUREVOLUME 0
#define OPACITY       1
#define INTENSITY     2



struct tfgraph {
       short type;
       short n;
       short i;
       long  imx;
       long  imy;
       float xscale;
       float yscale;
       float x[ARRAYMAX];
       float y[ARRAYMAX];
};

/*
struct control {
       short n;
       short i;
       long  imx;
       long  imy;
       float xscale;
       float yscale;
       float x[ARRAYMAX];
       float y[ARRAYMAX];

}
*/

struct glwindow {
       short type;
       long winid;
       int  windowlimit;
       long xorigin;
       long yorigin;
       long xsize;
       long ysize;
       long llx;
       long lly;
       long urx;
       long ury;
       float xscale;
       float yscale;
       tfgraph *graph;
//       control *view;
};


#define WINDOWSTART   0
#define WINDOWINPUT   1
#define WINDOWUPDATE  2
#define WINDOWRESHAPE 3
#define WINDOWENTER   4
#define WINDOWLUT     5


#define FONTXSIZE   7
#define FONTYSIZE   11


int   voRead (fileheader & imap,  char *filename);
void  formulae (char *f, short type, void *values, tfgraph &tf);
int   readvolume (fileheader & imap,char *filename, short scaledown, volume *v);
int   readHeart (volume *v);
int   readdogHeart ( volume *v, short type);
int   readdogHeartII ( volume *v);
int   readHighresHeart (volume *v);
int   readHighresHeartII (volume *v, int filenumber);

int   bfOpen(int *, char *);
int   bfRead(int, void *, UNS32);
int   bfSeek(int, UNS32);
int   bfWrite(int, void *, UNS32);
int   bfClose(int);


float dg_to_unix (char *field);
float unix_to_dg (float number);


 
// end of vortex
#endif

