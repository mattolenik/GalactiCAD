/*
 *  Copyright (c) Tien-Tsin Wong 1996
 *  All Right Reserved.
 *
 *  Adaptive Skeleton Climbing (Library interface)
 *
 *  This program implements the adaptive skeleton climbing (ASC) algorithm
 *  which extracts the isosurface from the 3D voxel data. This is a
 *  multiresolution techniques to extract the isosurface in order to
 *  reduce the total no of triangles.
 * 
 *  This library interface restricts the usage of my asc algorithm.
 *  The aim of this routine is to provide a simple interface for novice
 *  user.
 *  For detail description of the algorithm, see the outline.
 *
 *  First version: 10 Sept 1996
 */

#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include <string.h>
#include <limits.h>
#include <memory.h>
#include "asc.h"
#include "misc.h"
#include "common.h"
#include "datatype.h"
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
#define D_SPHERE  	1
#define D_KNOT    	2
#define D_MIRA    	3
#define D_HEIGHTFIELD 	4
#define D_RAW		5
#define LAYERNO   	3

#ifdef ASCHEADER1
void asc1(volume *v, float threshold, char *outfile)
#elif  ASCHEADER2
void asc2(volume *v, float threshold, char *outfile)
#elif  ASCHEADER4 
void asc4(volume *v, float threshold, char *outfile)
#elif  ASCHEADER8
void asc8(volume *v, float threshold, char *outfile)
#endif
{
  // Init global variables.
  G_Threshold = threshold;
  G_mindpvalue=0;
  G_Stat_TriangleCnt=0;// total no of triangles generated
  G_DataWidth=129;
  G_DataDepth=129;
  G_DataHeight=129;
  G_WidthScale=1.0;    // scale factor of the voxel. 
  G_DepthScale=1.0;    // used only when calculating the world coordinate of vetex
  G_HeightScale=1.0;  
  G_WidthScale_2=0.5;  // G_WidthScale / 2
  G_DepthScale_2=0.5;  // G_DepthScale / 2
  G_HeightScale_2=0.5; // G_HeightScale / 2
  G_NonEmptyBlockCnt=0;   // Count the total no of empty block(without isosurface crossing)
  G_HighriceCnt=0;
  G_EmptyHighriceCnt=0;

  // Initialization some global stuffs
  LignNullSimpleInit();
  PadiInitEdgeTable();
  DikeTableInit();

  // Local variable and some default action/value
  float utimestart, utimeend, dummytime;
  int i, j, k, bkwidth, bkdepth, bkheight;
  CHAR withnormal=TRUE, format=TRIBINARY;
  CHAR usekdtree=FALSE;
  FILE *fptr=NULL;
  G_NonEmptyBlockCnt = 0;
  G_AngleThresh = 15.0*M_PI/180.0;
  G_CosAngleThresh = cos(G_AngleThresh);
  G_HandleAmbiguity = TRUE;
  G_HandleBeauty = TRUE;
  fptr = stdout;

  G_data1 = (VOXELDT*)v->data;
  G_DataWidth  = v->xsize;
  G_DataDepth  = v->ysize;
  G_DataHeight = v->datazres;
  G_WidthScale = v->xmap[1];  // assume constant scale across each slices
  G_DepthScale = v->ymap[1];
  G_HeightScale= v->zmap[1];
  fprintf(stderr, "x: %d   y: %d   z: %d\n", G_DataWidth, G_DataDepth, G_DataHeight);
  fprintf(stderr, "xscale: %f  yscale: %f   zscale:%f\n", G_WidthScale, G_DepthScale, G_HeightScale);

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
    strcpy(filetype, "wb");
    if ((fptr=fopen(outfile,filetype))==NULL)
      fptr = stdout;
  }

  fprintf(stderr, "Start doing adaptive skeleton climbing\n");

#ifndef WIN32
  GetCpuTime(&utimestart, &dummytime);
#endif

  Block *layer[3], *kminus1, *kminus2, *kminus0;
  Block *bottom, *top, *nearxz, *farxz, *nearyz, *faryz;
  int currij;
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
	}
	if (k>=2 && !kminus2[currij].EmptyQ())  // skip when empty, assume Init() do not allocate memory
	  kminus2[currij].Cleanup();
      }
  }
  for (i=0 ; i<3 ; i++) // free the layers
    free(layer[i]);

  fprintf(stderr, "Total no of Triangles: %d\n", G_Stat_TriangleCnt);

#ifndef WIN32
  GetCpuTime(&utimeend, &dummytime);
  fprintf(stderr, "Total cpu time (user) for data init: %15.2f\n", utimestart);
  fprintf(stderr, "Total cpu time (user) for asc only:  %15.2f\n", utimeend-utimestart);
#endif

  fprintf(stderr, "Empty block: %d out of %d blocks.\n", bkwidth*bkdepth*bkheight-G_NonEmptyBlockCnt, bkwidth*bkdepth*bkheight);
//  fprintf(stderr, "Empty highrice: %d out of %d highrices.\n", G_EmptyHighriceCnt, G_HighriceCnt);
  if (fptr!=stdout)
    fclose(fptr);
}



