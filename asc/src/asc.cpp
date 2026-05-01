/*
 *  Copyright (c) Tien-Tsin Wong 1996
 *  All Right Reserved.
 *
 *  Adaptive Skeleton Climbing
 *
 *  This program implements the adaptive skeleton climbing (ASC) algorithm
 *  which extracts the isosurface from the 3D voxel data. This is a
 *  multiresolution techniques to extract the isosurface in order to
 *  reduce the total no of triangles.
 * 
 *  For detail description of the algorithm, see the outline.
 *
 *  First version: 3 May 1996
 */

#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include <string.h>
#include <limits.h>
#include <memory.h>
#include "misc.h"
#include "common.h"
#include "asc.h"
#include "datatype.h"
#include "data.h"
#include "initdata.h"
#include "padi.h"
#include "farm.h"
#include "highrice.h"
#include "block.h"
#include "kdtree.h"
#include "index.h"
#include "pcvalues.h"

/////////////////////////// COMPILATION FLAGS ////////////////////////
//#define SECURITY   // similar to DEBUG. Define it when develop program,
		   // undefine it when you want to speed up the program
//#define DEBUG    // If this flag is on, all debug message will be dumped

//#define GENCOUNTVOLUME // Generate a voxel data textfile, each voxel
		       // represents the no of triangles generated at that
		       // cube.
///////////////////////// Global Variables //////////////////////////
//       z
//       ^       y
//       |     /
// height|   / depth
//       | /
//  0,0,0+---------> x
//          width
VOXELDT *G_data1;
VOXELDT G_Threshold=0;
double G_CosAngleThresh;  // cos angle threshold of the confirmation % gradient normal and triangle normal
double G_AngleThresh;     // angle of derivation constrain in degree
float G_mindpvalue=0;
long G_Stat_TriangleCnt=0;// total no of triangles generated
long G_DataWidth=129;
long G_DataDepth=129;
long G_DataHeight=129;
float G_WidthScale=1.0;    // scale factor of the voxel. 
float G_DepthScale=1.0;    // used only when calculating the world coordinate of vetex
float G_HeightScale=1.0;  
float G_WidthScale_2=0.5;  // G_WidthScale / 2
float G_DepthScale_2=0.5;  // G_DepthScale / 2
float G_HeightScale_2=0.5; // G_HeightScale / 2
long G_NonEmptyBlockCnt=0;   // Count the total no of empty block(without isosurface crossing)
long G_HighriceCnt=0;
long G_EmptyHighriceCnt=0;

// Some flag to switch on/off some mechanism
CHAR G_HandleAmbiguity;   // Handle the ambiguity of crossing edge of padi
CHAR G_HandleBeauty;      // Handle the confirmation of gradient normal and triangle normal




//////////////////////////////// main /////////////////////////////////////
#ifdef GENCOUNTVOLUME
int ComputeConfig(int x, int y, int z)
{
  int config = 0;
  Data mydata(G_data1, -1, 0, 0, x, y, z, G_DataWidth, G_DataDepth, G_DataHeight);
  config |= mydata[0] << 0;
  config |= mydata[1] << 1;
  mydata.ReInit(G_data1, -1, 0, 0, x, y+1, z, G_DataWidth, G_DataDepth, G_DataHeight);
  config |= mydata[0] << 2;
  config |= mydata[1] << 3;
  mydata.ReInit(G_data1, -1, 0, 0, x, y, z+1, G_DataWidth, G_DataDepth, G_DataHeight);
  config |= mydata[0] << 4;
  config |= mydata[1] << 5;
  mydata.ReInit(G_data1, -1, 0, 0, x, y+1, z+1, G_DataWidth, G_DataDepth, G_DataHeight);
  config |= mydata[0] << 6;
  config |= mydata[1] << 7;
  return config;
}
#endif



#define D_SPHERE  	1
#define D_KNOT    	2
#define D_MIRA    	3
#define D_HEIGHTFIELD 	4
#define D_RAW		5
#define D_RAW16		6
#define LAYERNO   	3
void main(int argc, DCHAR **argv)
{
  // Initialization some global stuffs
  LignNullSimpleInit();
  PadiInitEdgeTable();
  DikeTableInit();

  // Local variable and some default action/value
  float utimestart, utimeend, dummytime;
  int i, j, k, argidx, bkwidth, bkdepth, bkheight;
  CHAR withnormal=TRUE, format=TRIBINARY, datavalue=D_SPHERE, threshgiven=FALSE;
  CHAR communicate=TRUE, usekdtree=FALSE;
  DCHAR mirafile[100], outfile[100], hffile[100], rawfile[100], idxfile[100];
  FILE *fptr=NULL;
  volume v;
  G_NonEmptyBlockCnt = 0;
  G_DataWidth = G_DataDepth = G_DataHeight = 128;
  G_WidthScale = G_DepthScale = G_HeightScale = 1.0;
  G_AngleThresh = 15.0*M_PI/180.0;
  G_CosAngleThresh = cos(G_AngleThresh);
  G_HandleAmbiguity = TRUE;
  G_HandleBeauty = TRUE;
  outfile[0] = 0;
  fptr = stdout;

  fprintf(stderr, "========================================\n\n");
  for (i=0 ; i<argc ; i++)
    fprintf(stderr, "%s ", argv[i]);
  fprintf(stderr, "\n\n");
  fprintf(stderr, "Usage:\n");
  fprintf(stderr, "  -f <outfile> specify output filename, default is stdout\n");
  fprintf(stderr, "  -ot   output TPoly\n");
  fprintf(stderr, "  -or   output RenderMan\n");
  fprintf(stderr, "  -ob   output triangle binary (propietrary format, default)\n");
  fprintf(stderr, "  -n+   with normal info (default)\n");
  fprintf(stderr, "  -n-   no normal info\n");
  fprintf(stderr, "  -t <threshold>   set the threshold\n");
  fprintf(stderr, "  -ds   init data with 2 metasphere (default)\n");
  fprintf(stderr, "  -dk   init data with knot surface\n");
  fprintf(stderr, "  -dh <pgm file>   init data with heightfield file in PGM\n");
  fprintf(stderr, "  -dm <mirafile>   specify the MIRA file to read as data\n");
  fprintf(stderr, "  -dr1 <rawfile> <w> <d> <h> specify 8-bit raw byte file with wxdxh\n");
  fprintf(stderr, "  -dr2 <rawfile> <w> <d> <h> specify 16-bit raw byte file with wxdxh\n");
  fprintf(stderr, "  -c+   communcate among blocks (default)\n");
  fprintf(stderr, "  -c-   do not communicate\n");
  fprintf(stderr, "  -r <res>   specify the resolution of the volume data (default %d)\n", G_DataWidth);
  fprintf(stderr, "  -s <sx> <sy> <sz>   explicitly scale the isosurface (default %f %f %f)\n", G_WidthScale, G_DepthScale, G_HeightScale);
  fprintf(stderr, "  -a <angle thresh>  set the initial angular threshold in degree (default: %5.2f degree)\n", G_AngleThresh*180/M_PI);
  fprintf(stderr, "  -ha+  handle ambiguity (default)\n");
  fprintf(stderr, "  -ha-  does not handle ambiguity\n");
  fprintf(stderr, "  -hb+  handle beauty of triangles (default)\n");
  fprintf(stderr, "  -hb-  does not handle beauty\n");
  fprintf(stderr, "  -i <idxfile> provide a kdtree indexed file for fast searching\n");

  for (argidx=1 ; argidx<argc ; argidx++)
    if (argv[argidx][0] == '-')
    {
      switch(argv[argidx][1])
      {
	case 'a':   // initial angle threshold
	  G_AngleThresh = atof(argv[++argidx]);
	  G_AngleThresh = G_AngleThresh*M_PI/180.0;
	  G_CosAngleThresh = cos(G_AngleThresh);
	  break;
	case 'c':   // communcation between blocks
	  if (argv[argidx][2]=='+')
	    communicate = TRUE;
	  else if (argv[argidx][2]=='-')
	    communicate = FALSE;
	  break;
	case 'd':   // data set: metaball(sphere), knot, MIRA file
	  if (argv[argidx][2]=='s')
	    datavalue = D_SPHERE;
	  else if (argv[argidx][2]=='k')
	    datavalue = D_KNOT;
	  else if (argv[argidx][2]=='h')
	  {
	    datavalue = D_HEIGHTFIELD;
	    strncpy(hffile, argv[++argidx], 100);
	  }
	  else if (argv[argidx][2]=='m')
	  {
	    datavalue = D_MIRA;
	    strncpy(mirafile, argv[++argidx], 100);
	  }
          else if (argv[argidx][2]=='r')
 	  {
            if (argv[argidx][3]=='1')
            {
              datavalue = D_RAW;
              strncpy(rawfile, argv[++argidx], 100);
              G_DataWidth = atoi(argv[++argidx]);
              G_DataDepth = atoi(argv[++argidx]);
              G_DataHeight= atoi(argv[++argidx]);
            }
            else if (argv[argidx][3]=='2')
            {
              datavalue = D_RAW16;
              strncpy(rawfile, argv[++argidx], 100);
              G_DataWidth = atoi(argv[++argidx]);
              G_DataDepth = atoi(argv[++argidx]);
              G_DataHeight= atoi(argv[++argidx]);
            }
	  }
	  break;
	case 'f':   // output filename
	  strncpy(outfile, argv[++argidx], 100);
	  break;
	case 'h':   // handle ambiguity and or beauty
	  if (argv[argidx][2]=='a')
	  {
	    if (argv[argidx][3]=='+')
	      G_HandleAmbiguity = TRUE;
	    else if (argv[argidx][3]=='-')
	      G_HandleAmbiguity = FALSE;
	  }
	  else if (argv[argidx][2]=='b')
	  {
	    if (argv[argidx][3]=='+')
	      G_HandleBeauty = TRUE;
	    else if (argv[argidx][3]=='-')
	      G_HandleBeauty = FALSE;
	  }
	  break;
	case 'i':  // provide kdtree index file for fast searching
	  strncpy(idxfile, argv[++argidx], 100);
	  usekdtree=TRUE;
	  break;
	case 'n':  // with or without normal
	  if (argv[argidx][2]=='+')
	    withnormal = TRUE;
	  else if (argv[argidx][2]=='-')
	    withnormal = FALSE;
	  break;
	case 'o':  // output format
	  if (argv[argidx][2]=='t')
	    format = TPOLY;
	  else if (argv[argidx][2]=='r')
	    format = RENDERMAN;
	  else if (argv[argidx][2]=='b')
	    format = TRIBINARY;
	  break;
	case 'r':  // resolution
	  G_DataWidth = G_DataDepth = G_DataHeight = atoi(argv[++argidx]);
	  break;
	case 's':  // scaling
	  G_WidthScale = atof(argv[++argidx]);
	  G_DepthScale = atof(argv[++argidx]);
	  G_HeightScale = atof(argv[++argidx]);
	  break;
	case 't':  // set the threshold
	  threshgiven = TRUE;
	  G_Threshold = (VOXELDT)atof(argv[++argidx]);
	  break;
      }
    }

  fprintf(stderr, "Initialize data voxel\n");
  switch(datavalue)
  {
    case D_SPHERE:
      if ((G_data1=(VOXELDT*)malloc(sizeof(VOXELDT)*G_DataWidth*G_DataDepth*G_DataHeight))==NULL)
        ERREXIT ("[main]: no memory for G_data1\n");
      InitDataMetaball(G_data1, G_DataWidth, G_DataDepth, G_DataHeight);
      if (!threshgiven)
	G_Threshold = (VOXELDT)100;
      break;
    case D_KNOT:
      if ((G_data1=(VOXELDT*)malloc(sizeof(VOXELDT)*G_DataWidth*G_DataDepth*G_DataHeight))==NULL)
	ERREXIT ("[main]: no memory for G_data1\n");
      InitKnotSurface(G_data1, G_DataWidth, G_DataDepth, G_DataHeight, 2);
      if (!threshgiven)
	G_Threshold = (VOXELDT)200;
      break;
    case D_HEIGHTFIELD:
      InitDataHeightField(G_data1, G_DataWidth, G_DataDepth, G_DataHeight, hffile);
      if (!threshgiven)
	G_Threshold = (VOXELDT)50;
      break;
    case D_MIRA:  // Due to the format of the MIRA file, you can only read it on UNIX
      if (!readMiraFile(&v, mirafile, 2, 0))
        ERREXIT("[main]: cannot read MIRA file\n");
      G_data1 = (VOXELDT*)v.data;
      G_DataWidth  = v.xsize;
      G_DataDepth  = v.ysize;
      G_DataHeight = v.datazres;
      G_WidthScale = v.xmap[1];  // assume constant scale across each slices
      G_DepthScale = v.ymap[1];
      G_HeightScale= v.zmap[1];
      if (!threshgiven)
	G_Threshold = (VOXELDT)50;
      fprintf(stderr, "x: %d   y: %d   z: %d\n", G_DataWidth, G_DataDepth, G_DataHeight);
      fprintf(stderr, "xscale: %f  yscale: %f   zscale:%f\n", G_WidthScale, G_DepthScale, G_HeightScale);
      break;
    case D_RAW: 
      if ((G_data1=(VOXELDT*)malloc(sizeof(VOXELDT)*G_DataWidth*G_DataDepth*G_DataHeight))==NULL)
	ERREXIT ("[main]: no memory for G_data1\n");
      ReadRawByte(G_data1, G_DataWidth, G_DataDepth, G_DataHeight, rawfile);
      if (!threshgiven)
	G_Threshold = (VOXELDT)100;
      break;
    case D_RAW16: 
      if ((G_data1=(VOXELDT*)malloc(sizeof(VOXELDT)*G_DataWidth*G_DataDepth*G_DataHeight))==NULL)
	ERREXIT ("[main]: no memory for G_data1\n");
      ReadRawByte16(G_data1, G_DataWidth, G_DataDepth, G_DataHeight, rawfile);
      if (!threshgiven)
	G_Threshold = (VOXELDT)100;
      break;
  }
  bkwidth  = (int)ceil((double)(G_DataWidth-1)/(double)N);
  bkdepth  = (int)ceil((double)(G_DataDepth-1)/(double)N);
  bkheight = (int)ceil((double)(G_DataHeight-1)/(double)N);
  // Setup rest of the global variables
  G_Stat_TriangleCnt = 0;
  G_WidthScale_2 = G_WidthScale / 2.0;
  G_DepthScale_2 = G_DepthScale / 2.0;
  G_HeightScale_2 = G_HeightScale / 2.0;

  // out data to where
  if (outfile[0]) // user specify output filename
  {
    DCHAR filetype[10];
    switch (format)
    {
      case TPOLY:
      case RENDERMAN: strcpy(filetype, "wt"); break;
      case TRIBINARY: strcpy(filetype, "wb"); break;
    }
    if ((fptr=fopen(outfile,filetype))==NULL)
      fptr = stdout;
  }

  fprintf(stderr, "Start doing adaptive skeleton climbing\n");

  DataBlock *indexdata=NULL;
  KdTree *kdtree=NULL;
  if (usekdtree)
  {
    ERRMSG("Reading Kdtree into memory ...\n");
    kdtree = ReadKdIndex(idxfile, G_DataWidth, G_DataDepth, G_DataHeight, indexdata);
  }

#ifndef WIN32
  GetCpuTime(&utimestart, &dummytime);
#endif

  if (communicate)
  {
    if (usekdtree)
    {
      DataBlock *db;
      long *idxlayer[3];
      Block *layer[3], *kminus1, *kminus2, *kminus0;
      Block *bottom, *top, *nearxz, *farxz, *nearyz, *faryz;
      int currxy, idxcnt[3], k_0, k_1, k_2, layersize=bkwidth*bkdepth;
      int cx, cy, cz;

      for (i=0 ; i<3 ; i++)  // 3 layers of blocks should be hold in memory
      {
	if ((layer[i]=(Block*)malloc(sizeof(Block)*layersize))==NULL
	||  (idxlayer[i]=(long*)malloc(sizeof(long)*layersize))==NULL)
	  ERREXIT("[main]: no memory for block layers or index layers\n");
	idxcnt[i] = 0;
      }
      for (k=0 ; k-2<bkheight ; k++) // process in a layer-by-layer fashion
      {
	kminus0 = layer[k_0=k%3];     // layer k
	kminus1 = layer[k_1=(k-1)%3]; // layer k-1
	kminus2 = layer[k_2=(k-2)%3]; // layer k-2

	if (k<bkheight)
	{
	  fprintf (stderr, "Processing layer %d ...\n", k*N);
	  for (i=0 ; i<layersize ; i++)
	    kminus0[i].SetEmpty();  // Set all block in current layer to empty
	  idxcnt[k_0] = 0;
	  QueryKdTree(kdtree, k, NLEVEL, G_Threshold, idxlayer[k_0], layersize, idxcnt[k_0]);
	  // process each non empty block
	  for (i=0 ; i<idxcnt[k_0] ; i++)
	  {
	    db = &(indexdata[idxlayer[k_0][i]]);
	    cx = db->XisQ();
	    cy = db->YisQ();
	    cz = db->ZisQ();
	    currxy = cy*bkwidth + cx;
	    kminus0[currxy].UnsetEmpty(); // set it to non empty block
	    kminus0[currxy].Init(G_data1, XDIM, YDIM, ZDIM, N*cx, N*cy, N*cz, G_DataWidth, G_DataDepth, G_DataHeight);
	    kminus0[currxy].BuildHighRice();  // skip when empty
	  }
	}
	if (k>=1 && k-1<bkheight) // process previous layer again
	  for (i=0 ; i<idxcnt[k_1] ; i++)  // communcate block in previous layers
	  {
	    db = &(indexdata[idxlayer[k_1][i]]);
	    cx = db->XisQ();
	    cy = db->YisQ();
	    cz = db->ZisQ();
	    currxy = cy*bkwidth + cx;
	    bottom = (k==1)?          NULL : &(kminus2[currxy]);
	    top    = (k==bkheight)?   NULL : &(kminus0[currxy]);
	    nearxz = (cy==0)?         NULL : &(kminus1[(cy-1)*bkwidth+cx]);
	    farxz  = (cy==bkdepth-1)? NULL : &(kminus1[(cy+1)*bkwidth+cx]);
	    nearyz = (cx==0)?         NULL : &(kminus1[cy*bkwidth+(cx-1)]);
	    faryz  = (cx==bkwidth-1)? NULL : &(kminus1[cy*bkwidth+(cx+1)]);
	    kminus1[currxy].CommunicateSimple(bottom, top, nearxz, farxz, nearyz, faryz);
	    kminus1[currxy].GenerateTriangle(format, withnormal, fptr);
	  }
	if (k>=2) // process layer k-2
	  for (i=0 ; i<idxcnt[k_2] ; i++)  // communcate block in previous layers
	  {
	    db = &(indexdata[idxlayer[k_2][i]]);
	    cx = db->XisQ();
	    cy = db->YisQ();
	    currxy = cy*bkwidth + cx;
	    kminus2[currxy].Cleanup();
	  }
      }
      for (i=0 ; i<3 ; i++) // free the layers
      {
	free(layer[i]);
	free(idxlayer[i]);
      }
      free(indexdata);
    }

    else  // old method use NO kdtree

    {
      Block *layer[3], *kminus1, *kminus2, *kminus0;
      Block *bottom, *top, *nearxz, *farxz, *nearyz, *faryz;
      int currij;
#ifdef GENCOUNTVOLUME
      long oldtricnt=0;
      FILE *countfile, *configfile;
      if ((countfile=fopen("asccnt", "wt"))==NULL)
        ERREXIT("[GENCOUNTVOLUME]: Cannot write counter file\n");
      if ((configfile=fopen("asccfg", "wt"))==NULL)
        ERREXIT("[GENCOUNTVOLUME]: Cannot write config file\n");
      fprintf(stderr, "\n\nSince you have turn on the GENCOUNTVOLUME compilation flag, the timing may not be corrected\n");
#endif
      for (i=0 ; i<3 ; i++)  // 3 layers of blocks should be hold in memory
	if ((layer[i]=(Block*)malloc(sizeof(Block)*bkwidth*bkdepth))==NULL)
	  ERREXIT("[main]: no memory for block layers\n");
      for (k=0 ; k-2<bkheight ; k++)
      {
	kminus0 = layer[k%3];     // layer k
	kminus1 = layer[(k-1)%3]; // layer k-1
	kminus2 = layer[(k-2)%3]; // layer k-2
	if (k<bkheight)
	  fprintf (stderr, "Processing layer %d ...\n", k*N);
	for (j=0 ; j<bkdepth ; j++)
        {
	  for (i=0 ; i<bkwidth ; i++)
	  {
	    currij  = j*bkwidth+i;
	    if (k<bkheight)
	    {
	      kminus0[currij].Init(G_data1, XDIM, YDIM, ZDIM, N*i, N*j, N*k, G_DataWidth, G_DataDepth, G_DataHeight);
	      if (!kminus0[currij].EmptyQ())
		kminus0[currij].BuildHighRice();  // skip when empty
	    }
	    if (k>=1 && k-1<bkheight && !kminus1[currij].EmptyQ())
	    {
	      bottom = (k==1)?         NULL : &(kminus2[currij]);
	      top    = (k==bkheight)?  NULL : &(kminus0[currij]);
	      nearxz = (j==0)?         NULL : &(kminus1[(j-1)*bkwidth+i]);
	      farxz  = (j==bkdepth-1)? NULL : &(kminus1[(j+1)*bkwidth+i]);
	      nearyz = (i==0)?         NULL : &(kminus1[j*bkwidth+i-1]);
	      faryz  = (i==bkwidth-1)? NULL : &(kminus1[j*bkwidth+i+1]);
	      kminus1[currij].CommunicateSimple(bottom, top, nearxz, farxz, nearyz, faryz);
	      kminus1[currij].GenerateTriangle(format, withnormal, fptr);
#ifdef GENCOUNTVOLUME
              fprintf(countfile, "%li ", G_Stat_TriangleCnt-oldtricnt);
              oldtricnt = G_Stat_TriangleCnt;
              fprintf(configfile, "%d ", ComputeConfig(i,j,k-1));
#endif
	    }

#ifdef GENCOUNTVOLUME
            if (k>=1 && k-1<bkheight && kminus1[currij].EmptyQ())
            { fprintf(countfile, "0 "); fprintf(configfile, "%d ", ComputeConfig(i,j,k-1)); }
#endif

	    if (k>=2 && !kminus2[currij].EmptyQ())  // skip when empty, assume Init() do not allocate memory
	      kminus2[currij].Cleanup();
	  }

#ifdef GENCOUNTVOLUME
	  if (k>=1 && k-1<bkheight)
          { fprintf(countfile, "\n");  fprintf(configfile,"\n"); }
#endif

        }
      }
      for (i=0 ; i<3 ; i++) // free the layers
	free(layer[i]);
#ifdef GENCOUNTVOLUME
      fclose(countfile);
      fclose(configfile);
#endif
    }
  }

  else // no communcation among blocks => gaps

  {
#ifdef GENCOUNTVOLUME
    long oldtricnt=0;
    FILE *countfile, *configfile;
    if ((countfile=fopen("asccnt", "wt"))==NULL)
      ERREXIT("[GENCOUNTVOLUME]: Cannot write counter file\n");
    if ((configfile=fopen("asccfg", "wt"))==NULL)
      ERREXIT("[GENCOUNTVOLUME]: Cannot write config file\n");
    fprintf(stderr, "\n\nSince you have turn on the GENCOUNTVOLUME compilation flag, the timing may not be corrected\n");
#endif
    Block block;
    for (k=0 ; k<bkheight ; k++)
    {
      fprintf (stderr, "Processing layer %d ...\n", k*N);
      for (j=0 ; j<bkdepth ; j++)
      {
        for (i=0 ; i<bkwidth ; i++)
        {
          block.Init(G_data1, XDIM, YDIM, ZDIM, N*i, N*j, N*k, G_DataWidth, G_DataDepth, G_DataHeight);
          if (!block.EmptyQ()) // skip if no isosurface crossing
          {
            block.BuildHighRice();
            // no communicate info between neighbor block
	    block.GenerateTriangle(format, withnormal, fptr);
            block.Cleanup();
          }
#ifdef GENCOUNTVOLUME
          fprintf(countfile, "%li ", G_Stat_TriangleCnt-oldtricnt);
          oldtricnt = G_Stat_TriangleCnt;
          fprintf(configfile, "%d ", ComputeConfig(i,j,k));
#endif
        }
#ifdef GENCOUNTVOLUME
        fprintf(countfile,  "\n");
        fprintf(configfile, "\n");
#endif
      }
    }
#ifdef GENCOUNTVOLUME
    fclose(countfile);
    fclose(configfile);
#endif
  }

  switch(format)
  {
    case TPOLY:     break; // not yet implemented
    case RENDERMAN: printf("# Total no of triangles: %d\n", G_Stat_TriangleCnt); break;
  }

  fprintf(stderr, "Total no of Triangles: %d\n", G_Stat_TriangleCnt);
  if (G_HandleBeauty)
    fprintf(stderr, "Max angle derivation of normal vector: %f degree\n", acos(G_mindpvalue)/M_PI*180);

#ifndef WIN32
  GetCpuTime(&utimeend, &dummytime);
  fprintf(stderr, "Total cpu time (user) for data init: %15.2f\n", utimestart);
  fprintf(stderr, "Total cpu time (user) for asc only:  %15.2f\n", utimeend-utimestart);
#endif

  fprintf(stderr, "Empty block: %d out of %d blocks.\n", bkwidth*bkdepth*bkheight-G_NonEmptyBlockCnt, bkwidth*bkdepth*bkheight);
//  fprintf(stderr, "Empty highrice: %d out of %d highrices.\n", G_EmptyHighriceCnt, G_HighriceCnt);
  free(G_data1);
  if (fptr!=stdout)
    fclose(fptr);
}



