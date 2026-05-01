//
// block.cpp
//
// Object Block. It constrains the max size of highrice. 
// All the isosurface generation processes are done in this object.
//
// Tien-Tsin Wong 1996
//
#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include <string.h>
#include "asc.h"
#include "misc.h"
#include "common.h"
#include "datatype.h"
#include "data.h"
#include "dikelign.h"
#include "farm.h"
#include "slab.h"
#include "doublist.h"
#include "highrice.h"
#include "block.h"
#include "vecmath.h"
#include "global.h"
#include "common.h"
#include "pcvalues.h"

#define THINTHRESH 0.25
#define FATTHRESH  0.5
#define HIGHRICEDIM(s,h) { printf(s); printf(" %d x %d x [%d,%d]\n", \
                           (h)->dike[0], (h)->dike[1], (h)->bottom, (h)->top); }


////////////////////////// Class Block //////////////////////////
void Block::Init(VOXELDT *data, CHAR xis, CHAR yis, CHAR zis,
                 int offx, int offy, int offz,
                 int datadimx, int datadimy, int datadimz)
{
  BlockData = data;
  DataDimX=datadimx;
  DataDimY=datadimy;
  DataDimZ=datadimz; // real size of the data
  OffX=offx;
  OffY=offy;
  OffZ=offz;
  EXYZis = 0;
  SetXis(xis);
  SetYis(yis);
  SetZis(zis);
  highricelist=NULL;

  // init x y z occ[] and ver[]
  int pos, i, j;
  CHAR nonempty=0;
  Data mydata(BlockData,-1,0,0,OffX,OffY,OffZ,DataDimX,DataDimY,DataDimZ);
  for (j=0 ; j<N+1 ; j++)
    for (i=0 ; i<N+1 ; i++)
    {
      pos = (j*(N+1)+i)*SIZE;
      mydata.ReInit(BlockData,-1,i,j,OffX,OffY,OffZ,DataDimX,DataDimY,DataDimZ);
      Initocc(mydata, &(xocc[pos]));
      Initver(&(xocc[pos]), &(xver[pos]));
      mydata.ReInit(BlockData,i,-1,j,OffX,OffY,OffZ,DataDimX,DataDimY,DataDimZ);
      Initocc(mydata, &(yocc[pos]));
      Initver(&(yocc[pos]), &(yver[pos]));
      mydata.ReInit(BlockData,i,j,-1,OffX,OffY,OffZ,DataDimX,DataDimY,DataDimZ);
      Initocc(mydata, &(zocc[pos]));
      Initver(&(zocc[pos]), &(zver[pos]));
      nonempty |= (xocc[pos+1] | yocc[pos+1] | zocc[pos+1]);
    }
  if (!nonempty)
    SetEmpty();
  else
    G_NonEmptyBlockCnt++;
}


void Block::Initocc(Data &data, CHAR *occ)
{
  register int i;
  register CHAR d1, d2;

  // Construct bottom level of the binary tree
  for(i=0 ; i<N ; i++)
  {
    d1 = data[i];   // This is not because the cost of dereferencing,
    d2 = data[i+1]; // but also operator[] is actually a function.
    occ[i+N] = ((d1<<1)|(~d1&0x01)) & (((~d2&0x01)<<1)|d2);
  }

  // Recursively (iteratively) init occ from the bottom level to the top level
  for (i=N-1 ; i>0 ; i--)
    occ[i] = occ[i<<1] | occ[(i<<1)+1];
  occ[0] = 0; // undefined

#ifdef DEBUG
  DISPLAYTREE(occ);
#endif
}


void Block::Initver(CHAR *occ, SIMPLEDT *ver)
{
  register int i;
  // init the value of the bottom level
  for (i=0 ; i<N ; i++)
    if (occ[i+N]) // occ != 00
      ver[i+N] = i+N;
    else
      ver[i+N] = 0;

  // Iteratively construct higher level ver[] from the bottom
  for (i=N-1 ; i>0 ; i--)
    if (ver[i<<1] > 0) // left child is not 00
      ver[i] = ver[i<<1];
    else if (ver[(i<<1)+1] > 0) // right child is not 00
      ver[i] = ver[(i<<1)+1];
    else // both left and right child are 00
      ver[i] = 0;
  ver[0] = 0; // undefined

#ifdef DEBUG
  DISPLAYTREE(ver);
#endif
}


void Block::Cleanup()
{
  int i;
  // Clear up memory
  for (i=0 ; i<N+1 ; i++)
  {
    xyfarm[i].CleanUp();
    xzfarm[i].CleanUp();
    yzfarm[i].CleanUp();
  }
  delete highricelist;
  highricelist = NULL;
  SetEmpty();  // default set to empty block
}


DoublyList *Block::ProduceHighRice(Farm *farm)
{
#ifdef SECURITY
  if (farm==NULL)
  {
    ERRMSG("[ProduceHighRice]: invalid input value\n");
    return NULL;
  }
#endif
  int xydike[2], x, y, i, j, k, jj, holdercnt, competecnt;
  HighRice *currhighrice, *holder[N*N*N], *competitor[N*N*N];
  CHAR go_on, highricesuccess;

  // Init the slabs
  for (i=0 ; i<N ; i++)
    slab[i].Init(&(farm[i]), &(farm[i+1]));

  // Clean up the doubly linked list
  if (highricelist!=NULL)
    delete highricelist;
  if ((highricelist=new DoublyList)==NULL)
    ERREXIT ("[ProduceHighRice]: no memory for highricelist\n");

  for (j=0 ; j<N ; j++) // from bottom to top slab
  {
//  By experiment, skipping empty slab give no significant speed up, but
//  increase no of triangles generated.
//  if (slab[j].EmptyQ()) // skip empty slab to speed up
//    continue;		  // may cause generation of different set of highrices
    for (go_on=slab[j].FirstPadi(xydike) ; go_on ; go_on=slab[j].NextPadi(xydike))
    {
      x = xydike[0];
      y = xydike[1];
      jj=j+1;  // Search for max J
      while (jj<N && slab[jj].xlign[Start(y)].simple[x]==x
                  && slab[jj].ylign[Start(x)].simple[y]==y)
        jj++;
      jj--;
      // Comment: Actually, the highrice can grow downwards

      // Strategy used when there is overlapped highrice:
      // For each overlapped highrice,
      // 1) If current highrice is enclosed by existing highrice, throw current highrice away
      // 2) If current highrice enclosed by any existing highrice, throw that highrice away
      // 3) If current highrice only overlap with existing highrice, clip current
      //    highrice by that highrice.
      holdercnt = 0;
      if ((currhighrice = new HighRice)==NULL)
        ERREXIT ("[ProduceHighrice]: no memory for currhighrice\n");
      currhighrice->Init(x, y, j, jj);
      do // for each highrice which is broken up by overlapped highrice
      {
        if (holdercnt>0)  // consider clipped highrice
        {
          holdercnt--;   // decrement counter
          currhighrice = holder[holdercnt]; // pick one element from array
          holder[holdercnt] = NULL;
        }

        // Check whether it is already occupied. And find out competitors.
#ifdef HIGHRICESEARCH
        HighRice *tmphighrice;
        competecnt=0;
        for (tmphighrice=(HighRice*)highricelist->First() ; tmphighrice!=NULL ; tmphighrice=(HighRice*)highricelist->Next())
          if (tmphighrice->OverlapQ(currhighrice))
            competitor[competecnt++] = tmphighrice;
#else
        // book keeping routine not yet implemented
#endif

        highricesuccess = TRUE;
        for (k=0 ; k<competecnt ; k++)
          // Check whether currhighrice is enclosed by any competitor
          if (currhighrice->EnclosedByQ(competitor[k]))
          { // no need to continue, simply delete current highrice
#ifdef DEBUG
            HIGHRICEDIM("remove current highrice", currhighrice);
#endif
            delete currhighrice;
            currhighrice = NULL;
            highricesuccess = FALSE;
            break;
          }
          // If currhighrice enclose competitor currhighrice, just throw competitor away
          else if (competitor[k]->EnclosedByQ(currhighrice))
          {
#ifdef DEBUG
            HIGHRICEDIM("remove competitor highrice", competitor[k]);
#endif
            UntagSlab(competitor[k]);
            highricelist->Remove(competitor[k]);
            delete competitor[k];
            competitor[k]=NULL;
          }
          else // only partial overlaid, break the current highrice
          {
#ifdef DEBUG
            HIGHRICEDIM("before: break current highrice", currhighrice);
            HIGHRICEDIM("clipped by highrice", competitor[k]);
#endif
            currhighrice->ClipBy(competitor[k], holder, holdercnt);
            delete currhighrice;
            currhighrice = NULL;
            highricesuccess = FALSE;
            break; // no need to continue, since the clipped portion have to go through the whole test
          }

        if (highricesuccess)
        {
          TagSlab(currhighrice); // Tag those occupied region
          highricelist->Append(currhighrice);  // Insert the current padi into the doubly linked list
#ifdef DEBUG
          HIGHRICEDIM("current highrice born", currhighrice);
#endif
        }
      } while (holdercnt>0);
    }
  }

//  By experiment, no significant speedup, since there are only a little 
//  empty highrices. Moreover, this modification introduce program bugs
//  The bugs are not yet fixed, since not worthy. I can simply 
//  remove the skipping empty highrice process.
//  // Delete those highrice which are empty
//  HighRice *curr, *tmp;
//  for (curr=(HighRice*)highricelist->First() ; curr!=NULL ; G_HighriceCnt++)
//    if (curr->CheckEmpty(xyfarm)) // check whether the highrice is empty
//    {
//      tmp = curr;
//      curr=(HighRice*)highricelist->Next();
//      highricelist->Remove(tmp);
//      delete tmp;
//      G_EmptyHighriceCnt++;
//    }
//   else
//      curr=(HighRice*)highricelist->Next();
  return highricelist;
}



void Block::InitSimpleByHighRice()
{
  HighRice *curr;
  int j, i, k, xznear, xzfar, xzdikestart, xzdike, N_l;
  int yznear, yzfar, yzdikestart, yzdike;
  static CHAR first=TRUE;
  static Farm *lcfarm=NULL, // lcfarm is localfarm, its xlign is used as temporary
              *hzfarm=NULL; // array for xzfarm[].xlign[] and its ylign is used as
                            // temporary for yzfarm[].xlign[].
  if (first)
  { // The following memory will never be free once allocated
    if ((lcfarm=(Farm*)malloc(sizeof(Farm)*(N+1)))==NULL)
      ERREXIT("[InitSimpleByHighRice]: no memory for lcfarm\n");
    if ((hzfarm=(Farm*)malloc(sizeof(Farm)*(N+1)))==NULL)
      ERREXIT("[InitSimpleByHighRice]: no memory for hzfarm\n");
    first = FALSE;
  }

  for (k=0 ; k<N+1 ; k++)
    for (j=0 ; j<N+1 ; j++)
    {
      memcpy(lcfarm[k].xlign[j].simple, Lign::nullsimple, Lign::simplesize);
      memcpy(lcfarm[k].ylign[j].simple, Lign::nullsimple, Lign::simplesize);
      memcpy(hzfarm[k].xlign[j].simple, Lign::nullsimple, Lign::simplesize);
      memcpy(xyfarm[k].xlign[j].simple, Lign::nullsimple, Lign::simplesize);
      memcpy(xyfarm[k].ylign[j].simple, Lign::nullsimple, Lign::simplesize);
      memcpy(xzfarm[k].xlign[j].simple, Lign::nullsimple, Lign::simplesize);
      memcpy(xzfarm[k].ylign[j].simple, Lign::nullsimple, Lign::simplesize);
      memcpy(yzfarm[k].xlign[j].simple, Lign::nullsimple, Lign::simplesize);
      memcpy(yzfarm[k].ylign[j].simple, Lign::nullsimple, Lign::simplesize);
    }

  for (curr=(HighRice*)highricelist->First() ; curr!=NULL ; curr=(HighRice*)highricelist->Next())
  {
    xznear = Start(curr->dike[LEFT]);
    xzfar  = End(curr->dike[LEFT]);
    yznear = Start(curr->dike[TOP]);
    yzfar  = End(curr->dike[TOP]);
    xzdikestart = N+yznear;
    yzdikestart = N+xznear;
    xzdike = curr->dike[TOP];
    yzdike = curr->dike[LEFT];
    // init simple[] of xyfarm
    for (j=xznear ; j<xzfar ; j++)
    {
      xyfarm[curr->bottom].xlign[j].simple[xzdikestart] =
      hzfarm[curr->top+1 ].xlign[j].simple[xzdikestart] = xzdike;
      N_l = N - (xzfar-j);
      for (i=yznear ; i<yzfar ; i++)
      {
        xyfarm[curr->bottom].ylign[i].simple[j] = MAX(N_l,xyfarm[curr->bottom].ylign[i].simple[j]);
        xyfarm[curr->top+1 ].ylign[i].simple[j] = MAX(N_l,xyfarm[curr->top+1 ].ylign[i].simple[j]);
      }
    }

    for (j=curr->bottom ; j<=curr->top ; j++)
    { // set the xzfarm
      xzfarm[xznear].xlign[j].simple[xzdikestart] =
      lcfarm[xzfar ].xlign[j].simple[xzdikestart] = xzdike;
      // set the yzfarm
      yzfarm[yznear].xlign[j].simple[yzdikestart] =
      lcfarm[yzfar ].ylign[j].simple[yzdikestart] = yzdike;
    }
    // Since there is no binary restriction along Z direction, simple[]
    // is coded differently. only [0, N-1] entries are used. Each entry
    // holds N-l where l is the no of unit dikes from current dike to
    // the boundary imposed by the highrice faces.
    for (j=curr->bottom ; j<=curr->top ; j++)
    {
      N_l = N - (curr->top-j+1);
      for (i=yznear ; i<yzfar ; i++)  // Note: not i<=yzfar, cause extra fragmentation
      {
        xzfarm[xznear].ylign[i].simple[j] = MAX(N_l,xzfarm[xznear].ylign[i].simple[j]);
        xzfarm[xzfar ].ylign[i].simple[j] = MAX(N_l,xzfarm[xzfar ].ylign[i].simple[j]);
      }
      for (i=xznear ; i<xzfar ; i++)
      {
        yzfarm[yznear].ylign[i].simple[j] = MAX(N_l,yzfarm[yznear].ylign[i].simple[j]);
        yzfarm[yzfar ].ylign[i].simple[j] = MAX(N_l,yzfarm[yzfar ].ylign[i].simple[j]);
      }
    }
  }

  // Init the unused entries in the simple[] to appropiate values
  for (k=0 ; k<N+1 ; k++)
    for (j=0 ; j<N ; j++)
    { // fill the specially coded simple[]
      xyfarm[k].ylign[j].FillSpecSimpleVacancy();
      xzfarm[k].ylign[j].FillSpecSimpleVacancy();
      yzfarm[k].ylign[j].FillSpecSimpleVacancy();

      // fill up bottommost entry in each simple[] with max sized dike
      xyfarm[k].xlign[j].FillSimpleVacancy();
      hzfarm[k].xlign[j].FillSimpleVacancy();
      xzfarm[k].xlign[j].FillSimpleVacancy();
      lcfarm[k].xlign[j].FillSimpleVacancy();
      yzfarm[k].xlign[j].FillSimpleVacancy();
      lcfarm[k].ylign[j].FillSimpleVacancy();

      // For each lign, propagate info upwards int x ligns only
      xyfarm[k].xlign[j].PropagateUpSimple();
      hzfarm[k].xlign[j].PropagateUpSimple();
      xzfarm[k].xlign[j].PropagateUpSimple();
      lcfarm[k].xlign[j].PropagateUpSimple();
      yzfarm[k].xlign[j].PropagateUpSimple();
      lcfarm[k].ylign[j].PropagateUpSimple();

      // propagate info downward
      xyfarm[k].xlign[j].PropagateDownSimple();
      hzfarm[k].xlign[j].PropagateDownSimple();
      xyfarm[k].xlign[j].MaxSimple(&(hzfarm[k].xlign[j]));
      xzfarm[k].xlign[j].PropagateDownSimple();
      lcfarm[k].xlign[j].PropagateDownSimple();
      xzfarm[k].xlign[j].MaxSimple(&(lcfarm[k].xlign[j]));
      yzfarm[k].xlign[j].PropagateDownSimple();
      lcfarm[k].ylign[j].PropagateDownSimple();
      yzfarm[k].xlign[j].MaxSimple(&(lcfarm[k].ylign[j]));
    }

  // copy the simple info to xlign[N]
  for (k=0 ; k<N+1 ; k++)
  {
    memcpy(xyfarm[k].xlign[N].simple, xyfarm[k].xlign[N-1].simple, Lign::simplesize);
    memcpy(xzfarm[k].xlign[N].simple, xzfarm[k].xlign[N-1].simple, Lign::simplesize);
    memcpy(yzfarm[k].xlign[N].simple, yzfarm[k].xlign[N-1].simple, Lign::simplesize);
  }
}


void Block::BuildHighRice()
{
  int i;
  for (i=0 ; i<N+1 ; i++)
  {
    xyfarm[i].Init(XisQ(), YisQ(), i, xocc, yocc, xver, yver);
    xzfarm[i].Init(XisQ(), ZisQ(), i, xocc, zocc, xver, zver);
    yzfarm[i].Init(YisQ(), ZisQ(), i, yocc, zocc, yver, zver);

    xyfarm[i].ProducePadi(this);
#ifdef DEBUG
    Out2DPadiPS(BlockData, &(xyfarm[i]), OffX, OffY, OffZ, DataDimX, DataDimY, DataDimZ);
#endif
    xyfarm[i].InitSimpleByPadi();
  }
  highricelist = ProduceHighRice(xyfarm);
#ifdef DEBUG
  HighRiceStatistic(highricelist);
  Out3DHighRice(BlockData, xyfarm, highricelist, OffX, OffY, OffZ, DataDimX, DataDimY, DataDimZ);
#endif
  // Construct vertical farms
  InitSimpleByHighRice();
}



void Block::GenerateTriangle(CHAR format, CHAR withnormal, FILE *file)
{
  int i, pathno;
  HighRice *hrice;
  static CHAR first=TRUE;
  static int *edge, *path, *pathcnt;

  if (first)
  {
    first = FALSE;
    if ((edge=(int*)malloc(sizeof(int)*2*4*3*N*N))==NULL) // alloc enough (max when highrce==block) mem for edge.
      ERREXIT("[Block::GenerateTriangle]: no mem for edge\n");
    if ((pathcnt=(int*)malloc(sizeof(int)*8))==NULL) // at most 8 distinct paths
      ERREXIT("[Block::GenerateTriangle]: no mem for pathcnt\n");
    if ((path=(int*)malloc(sizeof(int)*(2*6*N*N+1)))==NULL) // atmost 1 edge in each unit square. and there are 6 faces, I use 12 for security
      ERREXIT("[Block::GenerateTriangle]: no mem for pathcnt\n");
  }

  for (i=0 ; i<N+1 ; i++)
  {
    xyfarm[i].ProducePadi(this, PP_HRICECONSTR);
    xzfarm[i].ProducePadi(this, PP_HRICECONSTR);
    yzfarm[i].ProducePadi(this, PP_HRICECONSTR);
#ifdef DEBUG
    Out2DPadiPS(Data, &(xyfarm[i]), OffX, OffY, OffZ, DataDimX, DataDimY, DataDimZ);
    Out2DPadiPS(Data, &(xzfarm[i]), OffX, OffY, OffZ, DataDimX, DataDimY, DataDimZ);
    Out2DPadiPS(Data, &(yzfarm[i]), OffX, OffY, OffZ, DataDimX, DataDimY, DataDimZ);
#endif
  }
  for (hrice=(HighRice*)highricelist->First() ; hrice!=NULL ; hrice=(HighRice*)highricelist->Next())
  {
    // in order to minimize memory requirement, a global edge table from class block is reused for each highrice
    hrice->SetupEdgeTable(xyfarm, xzfarm, yzfarm, edge);
    hrice->GeneratePath(path, pathcnt, pathno, edge);
    if (pathno) // nonzero no of path
      OutTriangle(hrice, path, pathcnt, pathno, format, withnormal, file);
    pathno=0;
  }
}



void Block::OutTriangle(HighRice *hrice, int *path, int *pathcnt,
			int pathno, CHAR format, CHAR withnormal, FILE *file)
{
  int i, cell[3], k, start=0, segcnt, j, vidx[3], tmp;
  int finished, searchstart;
  CHAR side;
  double ratio;
  float gradient1[3], gradient2[3], *vv, *nn;
  float cv1[3], cv2[3], cross[3];
  double anglethresh, cosanglethresh, thinthresh, fatthresh;
  static CHAR first=TRUE;
  static float *vert, *grad;
  static int elementno;
  if (first) // the following memory will never be free, once allocated
  {
    first = FALSE;
    // atmost 1 edge in each unit square. and there are 6 faces, I use 12 for security
    elementno = 3*(2*6*N*N+1);
    if ((vert=(float*)malloc(sizeof(float)*elementno))==NULL
    ||  (grad=(float*)malloc(sizeof(float)*elementno))==NULL)
      ERREXIT("[Block::OutTriangle]: no memory for vert and grad\n");
  }

  // for each node on the path, calculate its vertex location and gradient
  for (k=0, start=0, vv=vert, nn=grad ; k<pathno ; start+=pathcnt[k], k++)
    for (i=start ; i<start+pathcnt[k] ; i++, vv+=3, nn+=3)
    {
      if (3*i>elementno)
        ERREXIT("[Block::OutTriangle]: too little memory allocated for vert and grad\n");
      hrice->IndexToCoord(path[i], cell, side);
      CalVertex(vv, cell, side, ratio);
      CalFastGradient(gradient1, cell);
      if (ratio>0) // linear interpolated the gradient
      {
        switch(side)
        {
          case XDIM: if (cell[XDIM]+OffX<DataDimX) cell[XDIM]++; break;
          case YDIM: if (cell[YDIM]+OffY<DataDimY) cell[YDIM]++; break;
          case ZDIM: if (cell[ZDIM]+OffZ<DataDimZ) cell[ZDIM]++; break;
        }
        CalFastGradient(gradient2, cell);
        vlerp(gradient2, gradient1, ratio, gradient1);
      }
      gradient1[XDIM] *= G_WidthScale_2;
      gradient1[YDIM] *= G_DepthScale_2;
      gradient1[ZDIM] *= G_HeightScale_2; 
      vnormal(gradient1);   // normalize the gradient vector
      vcopy(gradient1, nn);
    }

  // for each disjoint path
  int idlecnt;
  for (k=0, start=0 ; k<pathno ; start+=pathcnt[k], k++)
  {
    segcnt = pathcnt[k];
    vidx[0] = (start-1)*3;
    anglethresh = G_AngleThresh;
    cosanglethresh = G_CosAngleThresh; // This constraint will be relaxed if no way to improved
    thinthresh = THINTHRESH; // define as constant as a trail
    fatthresh  = FATTHRESH; // cannot be too thin and not too fat
    idlecnt = 0;
    while (segcnt>=3)  // tesellate the polygon into triangles
    {
      searchstart = vidx[0]/3 + 1 - start;
      // find 3 "consecutive" points and make it vertices
      for (i=searchstart, j=0 ; j<3 ; )
      {
        int off = i%pathcnt[k]+start;
        if (path[off]>=0)
          vidx[j++] = 3*off; // record the index of vertices
        i = (i>=2000)? i%pathcnt[k]+1 : i+1;
      }
      idlecnt++;
      if (idlecnt > segcnt) // no triangle can be generated using this constraint
      {
        // **** SERIOUS BUG FOUND HERE ****
        // anglethresh = MIN(M_PI_2, anglethresh+0.15);  
        // The above original constraint is too tight that will introduce
	// inifinte loop and halt the program. Pi/2 is changed to Pi.
        anglethresh = MIN(M_PI, anglethresh+0.15);  // relax the constraint
        cosanglethresh = cos(anglethresh);
        thinthresh -= 0.0005; 	// Also relax the thin triangle constraint
        fatthresh += 0.0005;   	// Also relax the fat triangle constraint
        idlecnt = 1;  		// reset counter
      }

      finished = vidx[1];
      // Check for degenerate triangle
      // Degenerate triangle is possible when the isosurface "touch"
      // one or more vertex out of 8 vertex of the cell.
      // If degenerate triangle found, simply ignore it.
      if (!vequal(vert+vidx[0],vert+vidx[1])
      &&  !vequal(vert+vidx[0],vert+vidx[2])
      &&  !vequal(vert+vidx[1],vert+vidx[2]))
      {
        // To make the vertex direction confirm with the normal direction
        vsub(vert+vidx[2], vert+vidx[1], cv1);
        vsub(vert+vidx[0], vert+vidx[1], cv2);
        vcross(cv1, cv2, cross); // cross cv1 x cv2
        if (vdot(cross,grad+vidx[1])<0) // cross.n[0] make the vertex direction reverse
        { // swap v[0] and v[2], n[0] and n[2]
          tmp = vidx[0];   vidx[0] = vidx[2];   vidx[2] = tmp;
	}

        if (G_HandleBeauty)
        {
          // Find the angle derivation of triangle normal with average gradient normal
          float dp, avgnorm[3];  // calculate the average gradient normal
          vadd(grad+vidx[0], grad+vidx[1], avgnorm);
          vadd(grad+vidx[2], avgnorm, avgnorm);
          vscale(avgnorm, 1.0/3.0);
          vnormal(avgnorm);
          vnormal(cross);
          dp = vdot(avgnorm, cross);
          if (dp < 0)
            dp = -dp;
          if (dp < cosanglethresh)  // derivation too large, reject this triangle
            continue;  // REJECT IT !!!
          if (dp < G_mindpvalue)  // see whether there is any improvement in angle derivation
            G_mindpvalue = dp;

	  // Check whether it is thin triangle
	  // I check thin triangle by finding in radius (See Graphics Gems pp 20)
/*	  It seems does not work very well. Many thin triangles still cannot
	  be removed due to asc algorithm.
	  float area, in_radius, e1[3], e2[3], e3[3], len[3];
	  float fitness;
	  int okcnt=0;
	  len[0] = vlength(cv1);
	  len[1] = vlength(cv2);  // reuse previous computation
	  vsub(vert+vidx[2], vert+vidx[0], e1);
	  len[3] = vlength(e1);
          vcross(vert+vidx[0], vert+vidx[1], e1);
	  vcross(vert+vidx[1], vert+vidx[2], e2);
	  vcross(vert+vidx[2], vert+vidx[0], e3);
 	  vadd(e1, e2, e1);
	  vadd(e1, e3, e1);
	  area = vlength(e1);  // Ignore the "/ 2.0" since, 2.0 will be times again in calculating in_radius
	  in_radius = area / (len[0]+len[1]+len[2]);
	  for (int ii=0; ii<3 ; ii++)
	    if ((fitness=in_radius/len[ii])>thinthresh && fitness<fatthresh )
	      okcnt++;	// not too thin and not too fat
	  if (okcnt==0) 
	    continue;	// REJECT IT !!
*/
        }

        G_Stat_TriangleCnt++; // record no of triangle

        switch (format)
        {
	  case RENDERMAN:  OutRenderMan(vert,grad,vidx,withnormal,file); break;
	  case TPOLY:      OutTPoly(vert,grad,vidx,withnormal,file);     break;
	  case TRIBINARY:  OutTriBinary(vert,grad,vidx,withnormal,file); break;
	}
      }
      else
      {
        if (!vequal(vert+vidx[0],vert+vidx[1])
        &&  !vequal(vert+vidx[2],vert+vidx[1])) // then v1 is significant and cannot be removed, remove v0 or v2
          finished = vidx[0];
      }
      finished /= 3;
      path[finished] = -path[finished] - 1; // marked one vertex as processed
      segcnt--;
      idlecnt = 0;  // reset the counter
    }
  }
}


// Output RenderMan input format
void Block::OutRenderMan(float *v, float *n, int *idx, CHAR withnormal, FILE *file)
{
#ifdef SECURITY
  if (v==NULL || n==NULL)
  {
    ERRMSG("[Block::OutRenderMan]: invalid input value\n");
    return;
  }
#endif
  int a;
  // Output as RenderMan input format
  fprintf (file, "Polygon \"P\" [\n");
  for (a=0 ; a<3 ; a++)
    fprintf(file, "%f %f %f\n", v[idx[a]], v[idx[a]+1], v[idx[a]+2]);
  fprintf (file, "]\n");
  if (withnormal)
  {
    fprintf (file, "\"N\" [\n");
    for (a=0 ; a<3 ; a++)
      fprintf(file, "%f %f %f\n", n[idx[a]], n[idx[a]+1], n[idx[a]+2]);
    fprintf (file, "]\n");
  }
}


// Output TPoly object format
void Block::OutTPoly(float *v, float *n, int *idx, CHAR withnormal, FILE *file)
{
#ifdef SECURITY
  if (v==NULL || n==NULL)
  {
    ERRMSG("[Block::OutTPoly]: invalid input value\n");
    return;
  }
#endif
  int a;
  fprintf (file, "3\n");
  if (withnormal)
    for (a=0 ; a<3 ; a++)
      fprintf(file, "%f %f %f  %f %f %f\n", v[idx[a]], v[idx[a]+1], v[idx[a]+2], n[idx[a]], n[idx[a]+1], n[idx[a]+2]);
  else
    for (a=0 ; a<3 ; a++)
      fprintf(file, "%f %f %f\n", v[idx[a]+0], v[idx[a]+1], v[idx[a]+2]);
}



// Output Propietrary triangle binary format
// This format is not suitable for transfer to and from different machine
// due to the byte order and size of float may different.
// <v1.x> <v1.y> <v1.z> <n1.x> <n1.y> <n1.z>  
// <v2.x> <v2.y> <v2.z> <n2.x> <n2.y> <n2.z>  
// <v3.x> <v3.y> <v3.z> <n3.x> <n3.y> <n3.z>  .... all in "float"
void Block::OutTriBinary(float *v, float *n, int *idx, CHAR withnormal, FILE *file)
{
#ifdef SECURITY
  if (v==NULL || n==NULL)
  {
    ERRMSG("[Block::OutTriBinary]: invalid input value\n");
    return;
  }
#endif
  int i, j, cnt;
  float buffer[18];
  cnt = 0;
  for (i=0 ; i<3 ; i++)
  {
    for (j=0 ; j<3 ; j++)
      buffer[cnt++] = v[idx[i]+j];
    for (j=0 ; j<3 ; j++)
      if (withnormal)
	buffer[cnt++] = n[idx[i]+j];
      else
	buffer[cnt++] = 0; // must fill with some value if no normal
  }
  cp_fwrite(buffer, sizeof(float), 18, file);
}


void Block::CalVertex(float *coord, int *cell, CHAR side, double &ratio)
{
#ifdef SECURITY
  if (coord==NULL || cell==NULL || side<0 || side >2)
  {
    ERRMSG("[Block::CalVertex]: invalud input value\n");
    return;
  }
#endif
  int x, y, z;
  Data l(BlockData, -1,  0,  0, OffX, OffY, OffZ, DataDimX, DataDimY, DataDimZ);

  x = cell[XDIM];  y = cell[YDIM];  z = cell[ZDIM];
#ifdef SECURITY
  if (x<0 || x>N+1 || y<0 || y>N+1 || z<0 || z>N+1)
    ERREXIT ("[Block::CalVertex]: IndexCoord map to wrong coordinate\n");
#endif
  coord[0] = OffX + x;
  coord[1] = OffY + y;
  coord[2] = OffZ + z;
  // linearly interpolate the vertex position
#ifdef SECURITY
  if (cell[side]>N)
    ERRMSG("[Block::OutTriangle]: index out of bound\n");
#endif
  double x1, x2, y1, y2, z1, z2;
  switch (side)
  {
    case XDIM:
      l.ReInit(BlockData, -1, y, z, OffX, OffY, OffZ, DataDimX, DataDimY, DataDimZ);
      x1 = l.Value(x);  x2 = l.Value(x+1);
      ratio = (double)(G_Threshold-x1)/(x2-x1);
      coord[XDIM] += ratio;
      break;
    case YDIM:
      l.ReInit(BlockData, x, -1, z, OffX, OffY, OffZ, DataDimX, DataDimY, DataDimZ);
      y1 = l.Value(y);  y2 = l.Value(y+1);
      ratio = (double)(G_Threshold-y1)/(y2-y1);
      coord[YDIM] += ratio;
      break;
    case ZDIM:
      l.ReInit(BlockData, x, y, -1, OffX, OffY, OffZ, DataDimX, DataDimY, DataDimZ);
      z1 = l.Value(z);  z2 = l.Value(z+1);
      ratio = (double)(G_Threshold-z1)/(z2-z1);
      coord[ZDIM] += ratio;
      break;
  }
  coord[0] *= G_WidthScale;
  coord[1] *= G_DepthScale;
  coord[2] *= G_HeightScale;
#ifdef SECURITY
  if (coord[0]<0 || coord[1]<0 || coord[2]<0)
    ERRMSG("invalid coordinate\n");
#endif
}


// The true and exact gradient is not calculated in order to speed up
// by reducing no of multiplication and division.
void Block::CalFastGradient(float *gradient, int *cell)
{
  int x, y, z, xprev, yprev, zprev, xnext, ynext, znext;
  Data xl(BlockData, -1,  0,  0, OffX, OffY, OffZ, DataDimX, DataDimY, DataDimZ);
  Data yl(BlockData, -1,  0,  0, OffX, OffY, OffZ, DataDimX, DataDimY, DataDimZ);
  Data zl(BlockData, -1,  0,  0, OffX, OffY, OffZ, DataDimX, DataDimY, DataDimZ);

  x=cell[XDIM]+OffX;  y=cell[YDIM]+OffY;  z=cell[ZDIM]+OffZ;
  xprev = (x==0)? 0 : x-1;
  yprev = (y==0)? 0 : y-1;
  zprev = (z==0)? 0 : z-1;
  xnext = (x==DataDimX-1)? x : x+1;
  ynext = (y==DataDimY-1)? y : y+1;
  znext = (z==DataDimZ-1)? z : z+1;
  xl.ReInit(BlockData, -1, y, z, 0, 0, 0, DataDimX, DataDimY, DataDimZ);
  yl.ReInit(BlockData, x, -1, z, 0, 0, 0, DataDimX, DataDimY, DataDimZ);
  zl.ReInit(BlockData, x, y, -1, 0, 0, 0, DataDimX, DataDimY, DataDimZ);

  // The correct gradient is calculated in the following manner
  // gradient[XDIM] = (xl.Value(xnext) - xl.Value(xprev))/2.0 * G_WidthScale;
  // gradient[YDIM] = (yl.Value(ynext) - yl.Value(yprev))/2.0 * G_DepthScale;
  // gradient[ZDIM] = (zl.Value(znext) - zl.Value(zprev))/2.0 * G_HeightScale;

  // Instead an inexact gradient is calculated 
  gradient[XDIM] = xl.Value(xnext) - xl.Value(xprev);
  gradient[YDIM] = yl.Value(ynext) - yl.Value(yprev);
  gradient[ZDIM] = zl.Value(znext) - zl.Value(zprev);
}


// Share simple[] info among the neighbor block
void Block::CommunicateSimple(Block *bottom, Block *top, Block *nearxz, Block *farxz, Block *nearyz, Block *faryz)
{
  int i, j, face;
  SIMPLEDT *myx, *nbx, *myy, *nby;
  CHAR validface[6];

  // a neigbor block is valid if it exists and it is not empty
  validface[HR_BOTTOM] = bottom!=NULL && !bottom->EmptyQ();
  validface[HR_TOP]    = top!=NULL    && !top->EmptyQ();
  validface[HR_NEARXZ] = nearxz!=NULL && !nearxz->EmptyQ();
  validface[HR_FARXZ]  = farxz!=NULL  && !farxz->EmptyQ();
  validface[HR_NEARYZ] = nearyz!=NULL && !nearyz->EmptyQ();  // serious bug fixed, & =>&& , July 9
  validface[HR_FARYZ]  = faryz!=NULL  && !faryz->EmptyQ();

  for (face=0 ; face<6 ; face++)
    if (validface[face])
    {
      for (j=0 ; j<N+1 ; j++)
      {
        switch (face)
        {
          case HR_BOTTOM:
            myx = xyfarm[0].xlign[j].simple;
            myy = xyfarm[0].ylign[j].simple;
            nbx = bottom->xyfarm[N].xlign[j].simple;
            nby = bottom->xyfarm[N].ylign[j].simple;
            break;
          case HR_TOP:
            myx = xyfarm[N].xlign[j].simple;
            myy = xyfarm[N].ylign[j].simple;
            nbx = top->xyfarm[0].xlign[j].simple;
            nby = top->xyfarm[0].ylign[j].simple;
            break;
          case HR_NEARXZ:
            myx = xzfarm[0].xlign[j].simple;
            myy = xzfarm[0].ylign[j].simple;
            nbx = nearxz->xzfarm[N].xlign[j].simple;
            nby = nearxz->xzfarm[N].ylign[j].simple;
            break;
          case HR_FARXZ:
            myx = xzfarm[N].xlign[j].simple;
            myy = xzfarm[N].ylign[j].simple;
            nbx = farxz->xzfarm[0].xlign[j].simple;
            nby = farxz->xzfarm[0].ylign[j].simple;
            break;
          case HR_NEARYZ:
            myx = yzfarm[0].xlign[j].simple;
            myy = yzfarm[0].ylign[j].simple;
            nbx = nearyz->yzfarm[N].xlign[j].simple;
            nby = nearyz->yzfarm[N].ylign[j].simple;
            break;
          case HR_FARYZ:
            myx = yzfarm[N].xlign[j].simple;
            myy = yzfarm[N].ylign[j].simple;
            nbx = faryz->yzfarm[0].xlign[j].simple;
            nby = faryz->yzfarm[0].ylign[j].simple;
            break;
        }
        for (i=0 ; i<SIZE ; i++, myx++, myy++, nbx++, nby++)
        {
          *myx = MAX(*myx, *nbx);
          *myy = MAX(*myy, *nby);
        }
      }
    }
}

