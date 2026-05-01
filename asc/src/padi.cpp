//
// padi.cpp
//
// Object Padi. The subdivide rectangular 2D region on the farm.
// Isoline generation is done in this module. The isoline generation
// is basiclly done by lookup table analoguous to 3D marching cube's
// isosurface generation. The ambiguous cases are handled by
// sampling the center element.
//
// Tien-Tsin Wong 1996
//
#include <stdlib.h>
#include <stdio.h>
#include "asc.h"
#include "datatype.h"
#include "misc.h"
#include "common.h"
#include "global.h"
#include "data.h"
#include "dikelign.h"
#include "padi.h"
#include "farm.h"
#include "block.h"

// Since the plantout algorithm described in the outline seems to
// have bug in 2 cases, to work around it and improve the edge
// generation performance. I used a table lookup approach.
//#define PLANTOUT   // If this flag is on, used the plantout algorithm
                     // to find crossing edges. If this flag is off,
                     // use table lookup approach to find out crossing edges.

#ifndef PLANTOUT
CHAR *Padi::edgetable[256];
#endif

////////////////////////////// Class Padi //////////////////////////////////
#ifndef PLANTOUT
void PadiInitEdgeTable()
{
  int i, j;
  for (i=0 ; i<256 ; i++)
  {
    Padi::edgetable[i] = (CHAR*)malloc(4*sizeof(CHAR)); // assummed allocatable
    for (j=0 ; j<4 ; j++)
      Padi::edgetable[i][j] = (CHAR)-1;  // invalid values
  }
  // List all 14 cases, 2 null cases
  Padi::edgetable[0x81][0] = BOTTOM; Padi::edgetable[0x81][1] = RIGHT;
  Padi::edgetable[0x60][0] = RIGHT;  Padi::edgetable[0x60][1] = TOP;
  Padi::edgetable[0x21][0] = BOTTOM; Padi::edgetable[0x21][1] = TOP;
  Padi::edgetable[0x18][0] = TOP;    Padi::edgetable[0x18][1] = LEFT;
  Padi::edgetable[0x99][0] = TOP;    Padi::edgetable[0x99][1] = LEFT;
  Padi::edgetable[0x99][2] = BOTTOM; Padi::edgetable[0x99][3] = RIGHT;
  Padi::edgetable[0x48][0] = RIGHT;  Padi::edgetable[0x48][1] = LEFT;
  Padi::edgetable[0x09][0] = BOTTOM; Padi::edgetable[0x09][1] = LEFT;
  Padi::edgetable[0x06][0] = LEFT;   Padi::edgetable[0x06][1] = BOTTOM;
  Padi::edgetable[0x84][0] = LEFT;   Padi::edgetable[0x84][1] = RIGHT;
  Padi::edgetable[0x66][0] = RIGHT;  Padi::edgetable[0x66][1] = TOP;
  Padi::edgetable[0x66][2] = LEFT;   Padi::edgetable[0x66][3] = BOTTOM;
  Padi::edgetable[0x24][0] = LEFT;   Padi::edgetable[0x24][1] = TOP;
  Padi::edgetable[0x12][0] = TOP;    Padi::edgetable[0x12][1] = BOTTOM;
  Padi::edgetable[0x90][0] = TOP;    Padi::edgetable[0x90][1] = RIGHT;
  Padi::edgetable[0x42][0] = RIGHT;  Padi::edgetable[0x42][1] = BOTTOM;
}
#else
void PadiInitEdgeTable()
{}
#endif


void Padi::Init(SIMPLEDT xdike, SIMPLEDT ydike, Farm *farm=NULL, Block *block=NULL)
{
#ifdef SECURITY
  if (xdike<1 || xdike>=SIZE || ydike<1 || ydike>=SIZE)
  {
    ERRMSG("[Padi::Init]: invalid input valid\n");
    return;
  }
#endif
  int i;
  dike[RIGHT] = dike[LEFT] = ydike;
  dike[TOP] = dike[BOTTOM] = xdike;

  if (farm!=NULL)
    lignavail = TRUE;
  else
    return;

  lign[RIGHT]  = &(farm->ylign[End(xdike)]);   //right
  lign[TOP]    = &(farm->xlign[End(ydike)]);   //top
  lign[LEFT]   = &(farm->ylign[Start(xdike)]); //left;
  lign[BOTTOM] = &(farm->xlign[Start(ydike)]); //bottom;
  for (i=0 ; i<4 ; i++)
    occ[i] = lign[i]->occ[dike[i]];
  // reverse value in TOP and LEFT ie. 01 -> 10, 10 -> 01
  for (i=1 ; i<3 ; i++)
    occ[i] = (occ[i]&1)<<1 | (occ[i]&2)>>1;

#ifndef PLANTOUT
  lookupidx = 0;
  for (i=0 ; i<4 ; i++)
    lookupidx = (lookupidx<<2)|(3&occ[i]);
  if (G_HandleAmbiguity && (lookupidx==0x99 || lookupidx==0x66)) // ambiguous cases
    ResolveAmbiguity(xdike, ydike, farm, block);
#endif
}


#ifndef PLANTOUT
void Padi::ResolveAmbiguity(SIMPLEDT xdike, SIMPLEDT ydike, Farm *farm, Block *block)
{ // sample the centre data
#ifdef SECURITY
  if (farm==NULL || block==NULL)
  {
    ERRMSG("[Padi::ResolveAmbiguity]: invalid input value\n");
    return;
  }
#endif
  VOXELDT tl, tr, bl, br;  // value at four corner of the unit square
  double sample;
  int dim[3];
  int xmidpt=(Start(xdike)+End(xdike))>>1;  // round down
  int ymidpt=(Start(ydike)+End(ydike))>>1;
  CHAR xis=farm->XisV(),     yis=farm->YisV();
  CHAR xodd=Length(xdike)&1, yodd=Length(ydike)&1;
  // get bl and br
  dim[farm->FixDimV()] = farm->FixDimValV();
  dim[xis] = -1;
  dim[yis] = ymidpt;
  Data data(G_data1, dim[0], dim[1], dim[2],
            block->OffX, block->OffY, block->OffZ,
            block->DataDimX, block->DataDimY, block->DataDimZ);
  bl = data.Value(xmidpt);
  br = (xodd)? data.Value(xmidpt+1) : bl;
  // get tl and tr
  if (!yodd)
  {
    tl = bl;
    tr = br;
  }
  else
  {
    dim[yis] = ymidpt + 1;
    data.ReInit(G_data1, dim[0], dim[1], dim[2],
                block->OffX, block->OffY, block->OffZ,
                block->DataDimX, block->DataDimY, block->DataDimZ);
    tl = data.Value(xmidpt);
    tr = (xodd)? data.Value(xmidpt+1) : tl;
  }
  sample = (tl + tr + bl + br)/(double)4.0;  // sample the centre
  if (sample>=G_Threshold)
    if (lookupidx==0x99)
      lookupidx = 0x66;
    else // lookupidx == 0x66
      lookupidx = 0x99;
}
#else
void Padi::ResolveAmbiguity(Farm *, Block *)
{}
#endif

#ifdef PLANTOUT
void Padi::PlantOut()
{
  if (!lignavail)
    return;

  int k;
  // init forward and backward array
  fixidx = 0;
  for (k=0 ; k<4 ; k++)
  {
    forward[k]  = (k + 1 - (1 & (occ[k]>>1))) & 3;
    backward[k] = (k + 3 + (1 & occ[k])) & 3;
    fixidx = (fixidx<<2)|(3&occ[k]);  // construct the index to fix bug
  }
#ifdef DEBUG
  printf ("padi %d x %d\n", dike[BOTTOM], dike[LEFT]);
  printf ("init forward backward\n");
  for (k=0 ; k<4 ; k++)
    printf("occ[%d]=%d, 1 & occ[%d]>>1=%d\n", k, occ[k],k, 1&(occ[k]>>1));
  for (k=0 ; k<4 ; k++)
    printf("forward[%d]=%d, backward[%d]=%d\n", k, forward[k], k, backward[k]);
#endif DEBUG

  // plant the edges
  for (k=0 ; k<4 ; k++)
  {
    forward[backward[k]] = forward[k];
    backward[forward[k]] = backward[k];
  }

#ifdef DEBUG
  for (k=0 ; k<4 ; k++)
    printf("forward[%d]=%d, backward[%d]=%d, occ[%d]=%d\n", k, forward[k], k, backward[k], k, occ[k]);
#endif
}
#endif


void Padi::GetCrossPt(int side, float &x, float &y, float& spacing)
{
#ifdef SECURITY
  if (side<0 || side>N || spacing<0)
  {
    ERRMSG("[Padi:GetGrossPt]: invalid input value\n");
    return;
  }
#endif
  if (!lignavail)
    return;
  switch (side)
  {
    case RIGHT:  x=End(dike[BOTTOM])*spacing;
                 y=Start(lign[side]->ver[dike[side]])*spacing + spacing/2.0;
                 break;
    case LEFT:   x=Start(dike[BOTTOM])*spacing;
                 y=Start(lign[side]->ver[dike[side]])*spacing + spacing/2.0;
                 break;
    case TOP:    x=Start(lign[side]->ver[dike[side]])*spacing + spacing/2.0;
                 y=End(dike[LEFT])*spacing;
                 break;
    case BOTTOM: x=Start(lign[side]->ver[dike[side]])*spacing + spacing/2.0;
                 y=Start(dike[LEFT])*spacing;
                 break;
    default:
        printf ("[GetCrossPt]: input side is invalid\n");
        exit(1);
  }

#ifdef DEBUG
  if (x<0 || y<0)
  {
    printf ("[Padi::GetCrossPt]:padi %d x %d\n", dike[BOTTOM], dike[LEFT]);
    printf("[Err]:side=%d x=%f y=%f dike[side]=%d start=%d\n", side, x, y, dike[side], Start(lign[side]->ver[dike[side]]) );
  }
#endif
}


// DEBUG function to visualize the 2D edges formed
// It output PostScript statements. The callers must provide suitable
// header of the ps file before calling this function
void Padi::Draw2D(float spacing, float offset)
{
#ifdef SECURITY
  if (spacing<0 || offset<0)
  {
    ERRMSG("[Padi::Draw2D]: invalid input value\n");
    return;
  }
#endif
  if (!lignavail)
    return;

  int i, k, l;
  float x1, y1, x0, y0;

  // draw the padi box
  x0 = Start(dike[BOTTOM])*spacing+offset;
  y0 = Start(dike[LEFT])*spacing+offset;
  x1 = End(dike[BOTTOM])*spacing-offset;
  y1 = End(dike[RIGHT])*spacing-offset;
  printf("1 setlinewidth\nnewpath %f %f moveto %f %f lineto %f %f lineto %f %f lineto %f %f lineto stroke  closepath\n",
           x0, y0, x1, y0, x1, y1, x0, y1, x0, y0);

#ifdef PLANTOUT
  CHAR *array;
  PlantOut();
  // draw the edges
  if (fixidx==18 || fixidx==132) // two bug cases
    array = backward;
  else
    array = forward;
  for (k=0 ; k<4 ; k++)
    if (occ[k]==GO_UP && (l=array[k])!=k)
    {
      GetCrossPt(k, x0, y0, spacing);
      GetCrossPt(l, x1, y1, spacing);
      printf ("2 setlinewidth\nnewpath %f %f moveto %f %f lineto stroke closepath\n",
              x0, y0, x1, y1);
    }
#else
  // Draw edges by looking up the edge table.
  for (i=0 ; i<3 ; i+=2)
    if ((k=edgetable[lookupidx][i])!=-1 && (l=edgetable[lookupidx][i+1])!=-1)
    {
      GetCrossPt(k, x0, y0, spacing);
      GetCrossPt(l, x1, y1, spacing);
      printf ("2 setlinewidth\nnewpath %f %f moveto %f %f lineto stroke closepath\n",
              x0, y0, x1, y1);
    }
#endif
}



#ifdef PLANTOUT
void Padi::GenEdge(CHAR *edgearr, int &cnt)
{
#ifdef SECURITY
  if (edgearr==NULL)
  {
    ERRMSG("[Padi::GenEdge]: invalid input value\n");
    return;
  }
  if (!lignavail)
    ERRMSG("[PAdi::GenEdge]: no lign info avail to gen edge\n");
#endif

  int k, l;
  PlantOut();
  // draw the edges
  if (fixidx==18 || fixidx==132) // two bug cases
    array = backward;
  else
    array = forward;
  for (k=0 ; k<4 ; k++)
    if (occ[k]==GO_UP && (l=array[k])!=k)
    {
      edgearr[cnt++] = k;
      edgearr[cnt++] = l;
    }
}
#else
void Padi::GenEdge(CHAR *edgearr, int &cnt)
{
#ifdef SECURITY
  if (edgearr==NULL)
  {
    ERRMSG("[Padi::GenEdge]: invalid input value\n");
    return;
  }
  if (!lignavail)
    ERRMSG("[PAdi::GenEdge]: no lign info avail to gen edge\n");
#endif
  // Draw edges by looking up the edge table.
  int i, k, l;
  for (i=0 ; i<3 ; i+=2)
    if ((k=edgetable[lookupidx][i])!=-1 && (l=edgetable[lookupidx][i+1])!=-1)
    {
      edgearr[cnt++] = k;
      edgearr[cnt++] = l;
    }
}
#endif



// test whether the input padi enclose this
// An optimized version can be done by >> the
int Padi::EnclosedByQ(Padi *encloser)
{
#ifdef SECURITY
  if (encloser==NULL)
  {
    ERRMSG("[Padi::EnclosedByQ: invalid input value\n");
    return FALSE;
  }
#endif
  if (encloser->dike[TOP] > dike[TOP] || encloser->dike[LEFT] > dike[LEFT])
    return FALSE;  // since this is impossible for encloser
  if ((dike[TOP]>>(Level(dike[TOP])-Level(encloser->dike[TOP]))) != encloser->dike[TOP])
    return FALSE;  // check enclosure along x
  if ((dike[LEFT]>>(Level(dike[LEFT])-Level(encloser->dike[LEFT]))) != encloser->dike[LEFT])
    return FALSE;  // check enclosure along y
  return TRUE;
}


// test whether the input padi overlap with this one
int Padi::OverlapQ(Padi *padi)
{
#ifdef SECURITY
  if (padi==NULL)
  {
    ERRMSG("[Padi::OverlapQ]: invalud input value\n");
    return FALSE;
  }
#endif
  SIMPLEDT large, small;
  int i;
  for (i=RIGHT ; i<=TOP ; i++)  // 1st round: check along y
  {                             // 2nd round: check along x
    // check along x direction
    if (padi->dike[i] > dike[i])
    { large = dike[i];   small = padi->dike[i]; }
    else
    { large = padi->dike[i]; small = dike[i]; }
    // due to the binary restriction, overlap occur only enclosure occur along x and y direction
    if ((small>>(Level(small)-Level(large))) != large)
      return FALSE;  // check enclosure along x or y
  }
  return TRUE;
}



// Due to the scheme of dike formation. Two padi cannot overlap in
// a very tricky form. If one padi is clipped by another one,
// there are at most two portions of the original padi will
// Notice this function ASSUME only simple clipping (previous criteria).
// It also ASSUME no complete enclosure of each another
// The most general case this function can handle is:
//        +---+
//        |   |
//        |   |
//  +-----+---+------+
//  |     |   |      |
//  +-----+---+------+
//        |   |
//        |   |
//        +---+
// Return value:
// "this" will not not affected
// 1) holder    The clipped padi will be appended into holder array.
// 2) cnt       The amount of element in holder array.
void Padi::ClipBy(Padi *clipper, Padi **holder, int &cnt, Farm *farm, Block *block)
{
#ifdef SECURITY
  if (clipper==NULL || holder==NULL || cnt<0)
  {
    ERRMSG("[Padi::CliBy]: invalid input value\n");
    return;
  }
#endif
  int clipxstart,clipxend, clipystart, clipyend,
      thisxstart, thisxend, thisystart, thisyend;
  int dikeset[N], dikecnt, i;
  CHAR ligngiven = lignavail && farm!=NULL;
  clipxstart = Start(clipper->dike[3]);
  clipxend   = End(clipper->dike[3]);
  clipystart = Start(clipper->dike[2]);
  clipyend   = End(clipper->dike[2]);
  thisxstart = Start(dike[3]);
  thisxend   = End(dike[3]);
  thisystart = Start(dike[2]);
  thisyend   = End(dike[2]);

  if (thisxstart<clipxstart || thisxend>clipxend) // divide along x axis
  {
    if (thisxstart<clipxstart)
    {
      dikecnt=0;
      MinDikeSet(thisxstart,clipxstart-1,dikeset,dikecnt);
      for (i=0 ; i<dikecnt ; i++)
      { // append into the holder array
        if ((holder[cnt] = new Padi)==NULL)
          ERREXIT ("[Padi::ClipBy]: no memory for holder[]\n");
        if (!ligngiven)
          holder[cnt]->Init(dikeset[i], dike[LEFT]);
        else
          holder[cnt]->Init(dikeset[i], dike[LEFT], farm, block);
        cnt++;
      }
    }
    if (thisxend>clipxend)
    {
      dikecnt=0;
      MinDikeSet(clipxend, thisxend-1, dikeset,dikecnt);
      for (i=0 ; i<dikecnt ; i++)
      { // append into the holder array
        if ((holder[cnt] = new Padi)==NULL)
          ERREXIT ("[Padi::ClipBy]: no memory for holder[]\n");
        if (!ligngiven)
          holder[cnt]->Init(dikeset[i], dike[LEFT]);
        else
          holder[cnt]->Init(dikeset[i], dike[LEFT], farm, block);
        cnt++;
      }
    }
  }
  if (thisystart<clipystart || thisyend>clipyend) // divide along y
  {
    if (thisystart<clipystart)
    {
      dikecnt=0;
      MinDikeSet(thisystart, clipystart-1, dikeset,dikecnt);
      for (i=0 ; i<dikecnt ; i++)
      { // append into the holder array
        if ((holder[cnt] = new Padi)==NULL)
          ERREXIT ("[Padi::ClipBy]: no memory for holder[]\n");
        if (!ligngiven)
          holder[cnt]->Init(dike[BOTTOM], dikeset[i]);
        else
          holder[cnt]->Init(dike[BOTTOM], dikeset[i], farm, block);
        cnt++;
      }
    }
    if (thisyend>clipyend)
    {
      dikecnt=0;
      MinDikeSet(clipyend, thisyend-1, dikeset,dikecnt);
      for (i=0 ; i<dikecnt ; i++)
      { // append into the holder array
        if ((holder[cnt] = new Padi)==NULL)
          ERREXIT ("[Padi::ClipBy]: no memory for holder[]\n");
        if (!ligngiven)
          holder[cnt]->Init(dike[BOTTOM], dikeset[i]);
        else
          holder[cnt]->Init(dike[BOTTOM], dikeset[i], farm, block);
        cnt++;
      }
    }
  }
}



/*******************************************************
 * output the 2D slice and padi as a postscript image  *
 *******************************************************/
void Out2DPadiPS(VOXELDT *data1, Farm *farm, int offx, int offy, int offz,
                 int datadimx, int datadimy, int datadimz)
{
#ifdef SECURITY
  if (data1==NULL || farm==NULL)
  {
    ERRMSG("[Out2DPadiPS]: invalid input value\n");
    return;
  }
#endif
  int i, j, dim[3];
  float radius=1*5, spacing=10*5, offset=2*5;
  Padi *currpadi;
  CHAR xis, yis;

  printf("%%!\n100 100 translate\ngsave\n");
  // Draw the data point
  xis = farm->XisV();
  yis = farm->YisV();
  dim[farm->FixDimV()] = farm->FixDimValV();
  dim[xis] = -1;
  dim[yis] = 0;
  Data data(data1, dim[0], dim[1], dim[2], offx, offy, offz, datadimx, datadimy, datadimz);
  for (j=0 ; j<N+1 ; j++)
  {
    dim[yis] = j;
    data.ReInit(data1, dim[0], dim[1], dim[2], offx, offy, offz, datadimx, datadimy, datadimz);
    for (i=0 ; i<N+1 ; i++)
      if (data[i]) // above threshold, represented by cross
      {
        printf("newpath %f %f moveto %f %f lineto stroke closepath\n",
               i*spacing-radius, j*spacing-radius, i*spacing+radius,
               j*spacing+radius);
        printf("newpath %f %f moveto %f %f lineto stroke closepath\n",
               i*spacing-radius, j*spacing+radius, i*spacing+radius,
               j*spacing-radius);
      }
      else // below threshold, represented by hollow circle
        printf("newpath %f %f %f 0 360 arc stroke closepath\n",
               i*spacing, j*spacing, radius);
  }

  // Draw the padi
  for (currpadi=farm->padilist->First() ; currpadi!=NULL ; currpadi=farm->padilist->Next())
    currpadi->Draw2D(spacing, offset);
  printf("grestore\nshowpage\n");
}

